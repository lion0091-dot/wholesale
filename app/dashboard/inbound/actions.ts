"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import {
  fetchTraceRecord,
  isMtraceConfigured,
  isPlausibleTraceNo,
  MtraceNotConfiguredError,
} from "@/lib/livestock/mtrace-client";
import { cacheTraceRecord } from "@/lib/livestock/master-cache";
import { autoCloseDocuments, autoCloseDocumentsForScan } from "@/lib/livestock/auto-close";
import { autoLinkNumberlessScan } from "@/lib/livestock/auto-link-numberless";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/inbound";

/** inbound_scans.weight가 numeric(10,3)이라 이보다 크면 DB가 못 담는다 — 오류 문구가 그대로 새지 않게 먼저 막는다. */
const MAX_SCAN_WEIGHT = 9_999_999;

/** 입고는 현장 작업이라 staff까지 허용한다 (상품 마스터 수정은 manager 이상). */
const INBOUND_ROLES: OrgRole[] = ["owner", "manager", "staff"];

export type ScanType = "BARCODE_SCAN" | "CAMERA" | "EXCEL" | "MANUAL";

export interface ScanResult {
  scanId: string;
  traceNo: string;
  /** NORMAL: 재고 반영 완료 / PENDING_MAPPING: 상품 확인 필요 / EXCEPTION: 이력 못 찾음 */
  status: "NORMAL" | "PENDING_MAPPING" | "EXCEPTION";
  productId: string | null;
  masterFound: boolean;
  speciesGroup: string | null;
  partName: string | null;
  grade: string | null;
  slaughterDate: string | null;
  packingDate: string | null;
  /** 바코드에 실려 온 유통기한(GS1-128 AI 15/17). 없는 바코드도 많다. */
  bestBefore: string | null;
  /** 남은 일수. 음수면 이미 지났다 — 입고는 받되 화면이 경고한다. */
  daysLeft: number | null;
  /** 바코드·라벨에 적힌 표기중량. 저울 값(weight)과 대조한다. */
  labeledWeight: number | null;
  /** 실중량 - 표기중량. 표기중량이 없으면 null. */
  weightVariance: number | null;
  varianceRatio: number | null;
  /** 허용 오차(±2%)를 넘었나. 막지는 않고 화면에서 크게 알린다. */
  varianceExceeded: boolean;
  purchaseUnitPrice: number | null;
  /** 실중량 × 단가 (원). 단가가 없으면 null. */
  purchaseAmount: number | null;
  purchaseSupplier: string | null;
  /** 이력 정보로 상품을 새로 만든 경우 — 화면에서 "가격을 넣어달라"고 안내한다. */
  autoCreated: { productName: string; needsPrice: boolean } | null;
  /** 이 박스로 전표가 모두 채워져 저절로 마감됐다. */
  autoClosedDocument: boolean;
  /** 이 번호가 이미 마감된 전표에 있어서 박스가 이어지지 못했다(사무실이 다시 열어야 함). */
  matchedClosedDocument: boolean;
  /**
   * status가 EXCEPTION일 때만 의미 있다. "API_ERROR"(조회 자체를 못 함 — 인증키
   * 미설정 등)와 "NOT_FOUND"(조회는 됐지만 그 번호가 없음)는 화면에서 완전히
   * 다른 안내가 필요하다 — 전자는 "설정 문제"고 후자는 "번호 확인 필요"다.
   */
  failReason: "API_ERROR" | "NOT_FOUND" | null;
  failDetail: string | null;
  /** true면 인증키 미설정이 원인 — 재시도해도 절대 통과하지 않는다. */
  failIsNotConfigured: boolean;
  /**
   * 바코드 상품코드(GTIN) 학습과 전표 줄이 서로 다른 상품을 가리켰다. 입고는 GTIN 쪽으로
   * 했다(품목 자체에 붙은 코드라 더 구체적) — 하지만 조용히 넘기지 않고 화면이 알린다.
   * 전표를 잘못 골랐거나 GTIN 학습이 옛 상품에 묶여 있는 것 중 하나다.
   */
  productConflict: { gtinProductId: string; documentProductId: string } | null;
}

export interface DuplicateWarning {
  /** 직전 스캔 시각 (HH:MM) */
  lastScannedAt: string;
}

async function resolveInboundScope() {
  const context = await requireOrgRole(INBOUND_ROLES);
  const supabase = await createClient();

  let wholesalerId: string | null = null;

  if (context.organizationId) {
    const { data: organization } = await supabase
      .from("organizations")
      .select("wholesaler_id")
      .eq("id", context.organizationId)
      .maybeSingle();

    wholesalerId = (organization?.wholesaler_id as string | null) ?? null;
  }

  // super_admin은 조직 소속이 없는 한 자기 profile_id로 업체를 자동 매칭하지 않는다.
  // 과거 같은 계정으로 공급사 온보딩을 테스트했다면 wholesalers 행이 남아 있을 수 있는데,
  // 그걸 "내 회사"로 오인해 입고 처리를 대행해버리면 안 된다 (lib/supplier/scope.ts와 동일 판단).
  if (!wholesalerId && !context.isSuperAdmin) {
    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("id")
      .eq("profile_id", context.userId)
      .maybeSingle();

    wholesalerId = (wholesaler?.id as string | null) ?? null;
  }

  if (!wholesalerId) {
    throw new RbacError("공급사 업체 정보가 없어 입고를 처리할 수 없습니다.");
  }

  // 원가(매입단가)를 정할 수 있는 사람인가 — DB의 can_manage_wholesaler()와 같은 기준.
  // 조직 없이 profile_id로 업체가 잡힌 경우는 원 가입자(owner) 본인이다.
  const canManagePurchase =
    context.isSuperAdmin ||
    context.orgRole === "owner" ||
    context.orgRole === "manager" ||
    !context.organizationId;

  return { supabase, context, wholesalerId, canManagePurchase };
}

const PURCHASE_PRICE_FORBIDDEN_MESSAGE =
  "매입단가는 관리자(owner/manager)만 입력할 수 있습니다. 단가 칸을 비우고 입고하면 상품의 기본 매입단가가 적용됩니다.";

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

type Client = Awaited<ReturnType<typeof createClient>>;

interface TraceLookupResult {
  failReason: "API_ERROR" | "NOT_FOUND" | null;
  failDetail: string | null;
  failIsNotConfigured: boolean;
}

/**
 * 이력번호를 조회한다 — 마스터 캐시를 먼저 보고, 없을 때만 공공 API를 부르고 캐시에 적재한다.
 * 실패해도 던지지 않고 사유를 돌려준다(현장 입고를 막지 않는다).
 */
async function lookupTrace(supabase: Client, traceNo: string): Promise<TraceLookupResult> {
  const { data: cached } = await supabase
    .from("master_livestock")
    .select("trace_no")
    .eq("trace_no", traceNo)
    .maybeSingle();

  let failReason: TraceLookupResult["failReason"] = null;
  // 실패 사유의 실제 메시지 — NOT_FOUND(호출은 성공, 결과 없음)면 비워둔다.
  // API_ERROR일 때만 채워서 DB만 보고도 "승인 미반영"인지 "진짜 오류"인지 구분한다
  // (2026-09-22 — resultCode 오류가 NOT_FOUND로 오인되던 문제 수정 이후 도입).
  let failDetail: string | null = null;
  // API_ERROR 중에서도 "설정 자체가 안 됨"(재시도해도 절대 안 됨)과 "일시적 오류일
  // 수도 있음"(재시도하면 될 수도 있음)은 화면 안내가 달라야 한다(2026-09-23 발견).
  // DB(livestock_exception_log.reason)에는 API_ERROR 하나로만 남긴다 — CHECK 제약이
  // 정해진 4개 값만 허용해서 세분화된 값을 그대로 넘기면 저장 자체가 깨진다.
  let failIsNotConfigured = false;

  if (!cached) {
    if (!isMtraceConfigured()) {
      // 인증키 미발급 상태. 물건은 실제로 들어왔으므로 막지 않고 예외로 남긴다.
      failReason = "API_ERROR";
      failDetail = "이력 조회 인증키가 설정되지 않았습니다.";
      failIsNotConfigured = true;
    } else {
      try {
        const record = await fetchTraceRecord(traceNo);

        if (record) {
          // 공용 캐시 적재는 service_role로만 (lib/livestock/master-cache.ts 주석 참고).
          await cacheTraceRecord(record);
        } else {
          failReason = "NOT_FOUND";
        }
      } catch (error) {
        // 조회 실패로 현장 입고를 막지 않는다 — 예외로 남기고 나중에 보정한다.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[mtrace] ${traceNo} 이력 조회 실패:`, message);
        failReason = "API_ERROR";
        failDetail = message.slice(0, 500);
        // isMtraceConfigured()는 "셋 중 하나라도" 키가 있으면 true라 여기까지 왔지만,
        // 이 번호가 실제로 필요로 하는 기관(예: 닭인데 POULTRY_TRACE_API_KEY 없음)은
        // 여전히 미설정일 수 있다 — 그 경우도 "재시도해도 절대 안 통과"로 안내해야 한다.
        failIsNotConfigured = error instanceof MtraceNotConfiguredError;
      }
    }
  }

  return { failReason, failDetail, failIsNotConfigured };
}

/**
 * 현장이 "스캔 종료"를 눌렀어도 그 전표의 박스가 또 찍혔으면 아직 찍는 중이다 — 종료 표시를 저절로 푼다
 * (사람이 '스캔 다시 시작'을 누르지 않아도 사무실 카드가 '찍는 중'으로 돌아간다). 마감된 전표는 건드리지 않는다.
 */
async function resumeScanIfFinished(supabase: Client, scanId: string): Promise<void> {
  try {
    const { data: link } = await supabase.from("inbound_document_line_scans").select("line_id").eq("scan_id", scanId).maybeSingle();

    if (!link) return;

    const { data: line } = await supabase.from("inbound_document_lines").select("document_id").eq("id", link.line_id).maybeSingle();

    if (!line) return;

    const { data: doc } = await supabase.from("inbound_documents").select("id, status, scan_finished_at").eq("id", line.document_id).maybeSingle();

    if (doc && doc.status === "PENDING" && doc.scan_finished_at) {
      await supabase.rpc("set_documents_scan_finished", { p_document_ids: [doc.id], p_finished: false });
    }
  } catch (error) {
    console.error("[inbound] 스캔 종료 표시 해제 실패:", error instanceof Error ? error.message : error);
  }
}

interface FinishedScan {
  status: string;
  productId: string | null;
  autoCreated: { productName: string; needsPrice: boolean } | null;
  autoClosedDocument: boolean;
  matchedClosedDocument: boolean;
}

/**
 * 박스를 기록(또는 번호 교체)한 직후의 뒷처리. 실패해도 입고 자체는 이미 끝났으므로 어느 단계도 흐름을 막지 않는다.
 * ① 전표 줄에 붙이기(대조용, 재고와 무관 — 118) ② 바코드 상품코드 기록 ③ 상품 자동 생성 ④ 부위로 마저 붙이기 ⑤ 자동 마감.
 */
async function finishRecordedScan(
  supabase: Client,
  input: { scanId: string; status: string; gtin: string | null }
): Promise<FinishedScan> {
  let status = input.status;
  let productId: string | null = null;

  let linkedLineId: string | null = null;

  const { data: linkedLine, error: linkError } = await supabase.rpc("auto_link_scan_to_document_line", {
    p_scan_id: input.scanId,
  });

  linkedLineId = (linkedLine as string | null) ?? null;

  if (linkError) {
    console.error("[inbound] 전표 줄 자동 배정 실패:", linkError.message);
  }

  // 나중에 사람이 상품을 지정할 때 학습하려면 그 박스의 상품코드를 알아야 한다.
  if (input.gtin) {
    const { error: gtinError } = await supabase.rpc("set_scan_gtin", {
      p_scan_id: input.scanId,
      p_gtin: input.gtin,
    });

    if (gtinError) {
      console.error("[inbound] 상품코드 기록 실패:", gtinError.message);
    }
  }

  // 처음 취급하는 고기면 이력 정보(축종·부위·등급)로 상품을 자동 생성한다.
  // 공공 API가 이미 알려준 값을 사람이 다시 입력하게 할 이유가 없다.
  // 부위를 모르면 자동 생성이 건너뛰어지고 아래 목록에서 되묻는다.
  let autoCreated: FinishedScan["autoCreated"] = null;

  if (status === "PENDING_MAPPING") {
    const { data: created } = await supabase.rpc("autocreate_product_for_scan", { p_scan_id: input.scanId });
    const createdRow = created as Record<string, unknown> | null;

    if (createdRow?.product_id) {
      status = "NORMAL";
      productId = String(createdRow.product_id);

      if (createdRow.created) {
        autoCreated = {
          productName: String(createdRow.product_name ?? ""),
          needsPrice: Boolean(createdRow.needs_price),
        };
      }
    }
  }

  // 번호만으로 줄이 안 정해졌으면 부위로 마저 붙인다(쪼갠 전표의 줄 고르기, 번호 없는 줄의 무게·축종·부위 대조).
  // 상품 자동 생성 뒤에 해야 상품의 부위까지 쓸 수 있다.
  if (!linkedLineId) {
    await autoLinkNumberlessScan(supabase, input.scanId);
  }

  await resumeScanIfFinished(supabase, input.scanId);

  // 이 박스로 전표의 모든 줄이 채워졌고 문제 박스도 없으면 사람이 할 일이 없으니 마감해 둔다.
  const autoClosedDocument = (await autoCloseDocumentsForScan(supabase, input.scanId)).length > 0;

  // 어느 줄에도 안 이어졌는데 그 번호가 이미 마감된 전표에 있으면 사무실이 알아야 한다(뒤에 온 박스가 조용히 남지 않게).
  let matchedClosedDocument = false;

  if (!autoClosedDocument) {
    const { data: scanRow } = await supabase.from("inbound_scans").select("trace_no").eq("id", input.scanId).maybeSingle();
    const { data: linkRow } = await supabase.from("inbound_document_line_scans").select("line_id").eq("scan_id", input.scanId).maybeSingle();

    if (scanRow && !linkRow) {
      const { data: closedMatch } = await supabase
        .from("inbound_document_lines")
        .select("id, inbound_documents!inner(status)")
        .eq("inbound_documents.status", "CLOSED")
        .or(`trace_no.eq.${scanRow.trace_no},lot_no.eq.${scanRow.trace_no}`)
        .limit(1);

      matchedClosedDocument = (closedMatch ?? []).length > 0;
    }
  }

  return { status, productId, autoCreated, autoClosedDocument, matchedClosedDocument };
}

/**
 * 바코드/카메라 스캔 1건 처리.
 *
 * Lazy Loading: 마스터 캐시를 먼저 보고, 없을 때만 공공 API를 호출해 적재한다
 * (현장에서 찍을 때마다 외부 호출이 나가면 느리고 API 한도도 금방 찬다).
 *
 * 중복 의심(같은 번호 + 같은 중량 + 10분 이내)이면 DB가 DUPLICATE_SUSPECTED를
 * 던진다. 그때는 저장하지 않고 duplicate 정보를 돌려주고, 작업자가 "다른 박스"
 * 라고 확인하면 confirmDuplicate=true로 다시 부른다.
 */
export async function recordScanAction(input: {
  traceNo: string;
  weight: number;
  scanType: ScanType;
  productId?: string | null;
  memo?: string | null;
  confirmDuplicate?: boolean;
  /** 바코드에서 읽은 유통기한(YYYY-MM-DD). 없으면 null. */
  bestBefore?: string | null;
  /** 바코드·라벨의 표기중량. weight는 저울에 찍힌 실중량이다. */
  labeledWeight?: number | null;
  /** 건별 매입단가. 비우면 상품별 기본 매입단가가 따라 들어간다. */
  purchaseUnitPrice?: number | null;
  purchaseSupplier?: string | null;
  /**
   * GS1-128 라벨의 상품코드(GTIN). 이력번호가 개체(소 한 마리)를 가리킨다면
   * 이건 공급처가 품목에 부여한 코드다. 공공 이력조회가 부위를 주지 않는 것이
   * 실물로 확인돼(30단계), 부위 대신 이 코드로 상품을 학습한다.
   */
  gtin?: string | null;
  /**
   * 엑셀 대량 입고에서 온 행이면 그 행 ID. DB가 (import_row_id) 유니크로 같은
   * 행의 두 번째 입고를 거부한다 — 탭 두 개/재접속 자동재개가 겹쳐도 재고가
   * 두 배로 잡히지 않는다(20260930000097).
   */
  importRowId?: string | null;
}): Promise<ActionResult<ScanResult | { duplicate: DuplicateWarning }>> {
  try {
    const { supabase, canManagePurchase } = await resolveInboundScope();

    // 원가는 관리자만 정한다(정책, 2026-09-24). DB(record_inbound_scan)도 같은 검사를 하지만
    // 정부 API 호출 전에 여기서 먼저 끊어야 헛호출·예외 기록이 안 남는다.
    if (input.purchaseUnitPrice !== null && input.purchaseUnitPrice !== undefined && !canManagePurchase) {
      throw new RbacError(PURCHASE_PRICE_FORBIDDEN_MESSAGE);
    }

    const traceNo = input.traceNo.trim().toUpperCase();
    const gtin = input.gtin?.trim() || null;

    if (!isPlausibleTraceNo(traceNo)) {
      throw new RbacError("이력번호 형식이 올바르지 않습니다. 다시 스캔해주세요.");
    }

    if (!Number.isFinite(input.weight) || input.weight <= 0) {
      throw new RbacError("중량을 입력해주세요.");
    }

    if (input.weight > MAX_SCAN_WEIGHT) {
      throw new RbacError("중량이 너무 큽니다. 단위(kg)와 소수점을 확인해 주세요.");
    }

    // 바코드에서 0이나 터무니없는 표기중량이 읽혀 와도 입고를 막지 않는다 — 그 값만 없는 것으로 본다.
    const labeledWeight =
      input.labeledWeight && Number.isFinite(input.labeledWeight) && input.labeledWeight > 0 && input.labeledWeight <= MAX_SCAN_WEIGHT
        ? input.labeledWeight
        : null;

    // 1~2) 이력 조회 — 마스터 캐시를 먼저 보고, 없을 때만 공공 API를 부른다.
    const { failReason, failDetail, failIsNotConfigured } = await lookupTrace(supabase, traceNo);

    // 3) 상품을 자동으로 정할 수 있는지 본다. 사람이 직접 고른 값이 없을 때만.
    //
    //    순서: 바코드 상품코드 → 전표 줄.
    //    상품코드(GTIN)가 더 정확하다 — 품목 자체에 붙은 코드라 같은 소에서 나온
    //    등심과 안심을 구분한다. 전표는 이력번호 단위라, 한 마리가 여러 부위로
    //    쪼개져 여러 줄에 걸쳐 있으면 어느 줄인지 알 수 없다(그 경우 DB 함수가
    //    NULL을 돌려줘 되묻는다).
    let autoProductId: string | null = null;
    let productConflict: ScanResult["productConflict"] = null;

    if (!input.productId) {
      let fromGtin: string | null = null;

      if (gtin) {
        const { data: mapped } = await supabase.rpc("lookup_product_by_gtin", { p_gtin: gtin });

        fromGtin = (mapped as string | null) ?? null;
      }

      // 전표를 먼저 올려둔 물건은 여기서 확정된다 — 찍기만 하면 끝난다.
      // GTIN이 있어도 전표를 같이 본다 — 둘이 다른 상품이면 GTIN을 따르되 그 사실을 알린다.
      const { data: fromDocument } = await supabase.rpc("lookup_product_by_document_trace", {
        p_trace_no: traceNo,
      });
      const documentProductId = (fromDocument as string | null) ?? null;

      autoProductId = fromGtin ?? documentProductId;

      if (fromGtin && documentProductId && fromGtin !== documentProductId) {
        productConflict = { gtinProductId: fromGtin, documentProductId };
      }
    }

    // 4) 스캔 기록 (스캔 + 원장 + 재고 + 예외가 한 트랜잭션)
    const { data, error } = await supabase.rpc("record_inbound_scan", {
      p_trace_no: traceNo,
      p_weight: input.weight,
      p_scan_type: input.scanType,
      p_product_id: input.productId ?? autoProductId ?? null,
      p_fail_reason: failReason,
      p_fail_detail: failDetail,
      p_import_row_id: input.importRowId ?? null,
      p_memo: input.memo ?? null,
      p_confirm_duplicate: input.confirmDuplicate ?? false,
      p_best_before: input.bestBefore ?? null,
      p_labeled_weight: labeledWeight,
      p_purchase_unit_price: input.purchaseUnitPrice ?? null,
      p_purchase_supplier: input.purchaseSupplier ?? null,
    });

    if (error) {
      const duplicate = error.message.match(/DUPLICATE_SUSPECTED:(\d{2}:\d{2})/);

      if (duplicate) {
        return { success: true, data: { duplicate: { lastScannedAt: duplicate[1] } } };
      }

      // 같은 업로드 행을 다른 창(탭)이 먼저 입고시켰다. 실패가 아니라 "이미 됐다"다 —
      // 호출부(processImportChunkAction)가 행 상태를 건드리지 않고 넘어가게 구분한다.
      if (error.message.includes(IMPORT_ROW_UNIQUE_INDEX)) {
        throw new RbacError(IMPORT_ROW_ALREADY_PROCESSED);
      }

      if (error.message.includes("FORBIDDEN_PURCHASE_PRICE")) {
        throw new RbacError(PURCHASE_PRICE_FORBIDDEN_MESSAGE);
      }

      throw new Error(error.message);
    }

    const row = data as Record<string, unknown>;

    // 전표 줄 붙이기·상품 코드 기록·상품 자동 생성·자동 마감을 한 묶음으로 처리한다.
    const finished = row.scan_id
      ? await finishRecordedScan(supabase, { scanId: String(row.scan_id), status: String(row.status), gtin })
      : { status: String(row.status), productId: null, autoCreated: null, autoClosedDocument: false, matchedClosedDocument: false };

    row.status = finished.status;
    if (finished.productId) row.product_id = finished.productId;

    const autoCreated = finished.autoCreated;
    const autoClosedDocument = finished.autoClosedDocument;
    const matchedClosedDocument = finished.matchedClosedDocument;

    revalidatePath(REVALIDATE_PATH, "layout");
    revalidatePath("/dashboard/products");

    return {
      success: true,
      data: {
        scanId: String(row.scan_id),
        traceNo: String(row.trace_no),
        status: row.status as ScanResult["status"],
        productId: (row.product_id as string | null) ?? null,
        masterFound: Boolean(row.master_found),
        speciesGroup: (row.species_group as string | null) ?? null,
        partName: (row.part_name as string | null) ?? null,
        grade: (row.grade as string | null) ?? null,
        slaughterDate: (row.slaughter_date as string | null) ?? null,
        packingDate: (row.packing_date as string | null) ?? null,
        bestBefore: (row.best_before as string | null) ?? null,
        daysLeft: row.days_left === null || row.days_left === undefined ? null : Number(row.days_left),
        labeledWeight: toNumberOrNull(row.labeled_weight),
        weightVariance: toNumberOrNull(row.weight_variance),
        varianceRatio: toNumberOrNull(row.variance_ratio),
        varianceExceeded: Boolean(row.variance_exceeded),
        purchaseUnitPrice: toNumberOrNull(row.purchase_unit_price),
        purchaseAmount: toNumberOrNull(row.purchase_amount),
        purchaseSupplier: (row.purchase_supplier as string | null) ?? null,
        autoCreated,
        autoClosedDocument,
        matchedClosedDocument,
        // record_inbound_scan의 JSONB 반환값에는 안 실려 있다 — 위에서 API 호출
        // 직후 이미 계산해둔 로컬 값을 그대로 돌려준다(DB 왕복 불필요).
        failReason: row.status === "EXCEPTION" ? failReason : null,
        failDetail: row.status === "EXCEPTION" ? failDetail : null,
        failIsNotConfigured: row.status === "EXCEPTION" && failIsNotConfigured,
        productConflict,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

export interface SplitScanRow {
  productId: string;
  weight: number;
  /** 줄마다 따로 찍은 이력번호. 비우면 박스 코드를 쓴다. */
  traceNo?: string | null;
  gtin?: string | null;
}

/**
 * 박스 하나를 상품 여러 개로 나눠 입고한다. 전부 들어가거나 하나도 안 들어간다 —
 * 입력은 기록 전에 미리 다 검사하고, 그래도 중간에 실패하면 이미 넣은 줄을 취소한다(반쪽 입고가 재고에 남지 않게).
 * 같은 번호가 여러 줄에 걸치는 게 의도라 중복 확인은 건너뛴다.
 */
export async function recordSplitScansAction(input: {
  boxCode: string;
  rows: SplitScanRow[];
}): Promise<ActionResult<{ scanIds: string[] }>> {
  try {
    const { supabase, wholesalerId } = await resolveInboundScope();
    const boxCode = input.boxCode.trim().toUpperCase();
    const rows = input.rows.filter((row) => row.productId && Number.isFinite(row.weight) && row.weight > 0);

    if (rows.length < 2) {
      throw new RbacError("상품을 2개 이상 고르고 무게를 입력해주세요.");
    }

    const traces = rows.map((row) => (row.traceNo ?? "").trim().toUpperCase() || boxCode);

    for (const trace of traces) {
      if (!isPlausibleTraceNo(trace)) {
        throw new RbacError(`이력번호 형식이 올바르지 않습니다: ${trace || "(비어 있음)"}`);
      }
    }

    if (rows.some((row) => row.weight > MAX_SCAN_WEIGHT)) {
      throw new RbacError("중량이 너무 큽니다. 단위(kg)와 소수점을 확인해 주세요.");
    }

    const productIds = [...new Set(rows.map((row) => row.productId))];
    const { data: owned } = await supabase.from("products").select("id").eq("wholesaler_id", wholesalerId).in("id", productIds);

    if ((owned ?? []).length !== productIds.length) {
      throw new RbacError("선택한 상품을 찾을 수 없습니다. 화면을 새로고침한 뒤 다시 골라 주세요.");
    }

    const recorded: string[] = [];

    for (const [index, row] of rows.entries()) {
      const traceNo = traces[index];
      const result = await recordScanAction({
        traceNo,
        weight: row.weight,
        scanType: "MANUAL",
        productId: row.productId,
        confirmDuplicate: true,
        memo: traceNo === boxCode ? "박스 나눠서 입고" : `박스 나눠서 입고 (박스 ${boxCode})`,
        gtin: row.gtin ?? null,
      });
      const data = result.data as { scanId?: string } | undefined;

      if (!result.success || !data?.scanId) {
        for (const scanId of recorded) {
          await voidScanAction(scanId, "박스 나눠서 입고 중 실패로 취소");
        }

        throw new RbacError(
          `${index + 1}번째 줄 처리 중 실패했습니다: ${result.error ?? "알 수 없는 오류"}` +
            (recorded.length > 0 ? ` 앞서 넣은 ${recorded.length}건은 취소했으니 처음부터 다시 입력하세요.` : "")
        );
      }

      recorded.push(data.scanId);
    }

    return { success: true, data: { scanIds: recorded } };
  } catch (error) {
    return toResult(error);
  }
}

export interface ReplaceTraceResult {
  /** 교체된 새 박스 id. 조회가 여전히 안 돼 아무것도 안 바꿨으면 원래 박스 id. */
  scanId: string;
  traceNo: string;
  /** NORMAL: 재고 반영 / PENDING_MAPPING: 상품 확인 필요 / EXCEPTION: 이력 못 찾음 */
  status: "NORMAL" | "PENDING_MAPPING" | "EXCEPTION";
  /** 번호를 실제로 바꾸거나 다시 기록했는가. false면 재조회했지만 여전히 못 찾아 그대로 뒀다. */
  changed: boolean;
  autoCreatedProductName: string | null;
  autoClosedDocument: boolean;
  failReason: "API_ERROR" | "NOT_FOUND" | null;
  failDetail: string | null;
  failIsNotConfigured: boolean;
}

/**
 * 이력번호를 바로잡거나(다른 번호) 다시 조회한다(같은 번호). 재고에 안 들어간 박스(이력 못 찾음·상품 확인 필요)만 된다.
 * 옛 박스를 취소하고 같은 실중량으로 새 번호를 기록한 뒤 사람이 넣은 값을 옮긴다(마이그레이션 124) — 조회가 되면
 * 상품 생성·재고 반영·전표 줄 연결까지 원래 스캔과 같은 경로로 이어진다.
 */
async function replaceTrace(
  supabase: Client,
  input: { scanId: string; oldTraceNo: string; newTraceNo: string; confirmDuplicate: boolean }
): Promise<ActionResult<ReplaceTraceResult | { duplicate: DuplicateWarning }>> {
  const traceNo = input.newTraceNo.trim().toUpperCase();

  if (!isPlausibleTraceNo(traceNo)) {
    throw new RbacError("이력번호 형식이 올바르지 않습니다. 12자리 숫자(또는 묶음번호)를 확인해주세요.");
  }

  const lookup = await lookupTrace(supabase, traceNo);
  const sameNumber = traceNo === input.oldTraceNo.trim().toUpperCase();

  // 같은 번호를 다시 조회했는데 여전히 못 찾았으면 아무것도 바꾸지 않는다 — 박스를 헛되이 갈아치우지 않는다.
  if (sameNumber && lookup.failReason) {
    return {
      success: true,
      data: {
        scanId: input.scanId,
        traceNo,
        status: "EXCEPTION",
        changed: false,
        autoCreatedProductName: null,
        autoClosedDocument: false,
        failReason: lookup.failReason,
        failDetail: lookup.failDetail,
        failIsNotConfigured: lookup.failIsNotConfigured,
      },
    };
  }

  const { data, error } = await supabase.rpc("replace_inbound_scan_trace_no", {
    p_scan_id: input.scanId,
    p_new_trace_no: traceNo,
    p_fail_reason: lookup.failReason,
    p_fail_detail: lookup.failDetail,
    p_confirm_duplicate: input.confirmDuplicate,
  });

  if (error) {
    const duplicate = error.message.match(/DUPLICATE_SUSPECTED:(\d{2}:\d{2})/);

    if (duplicate) {
      return { success: true, data: { duplicate: { lastScannedAt: duplicate[1] } } };
    }
    if (error.message.includes("SCAN_NOT_EDITABLE")) {
      throw new RbacError("이미 재고에 들어갔거나 취소된 박스는 번호를 바꿀 수 없습니다. 새로고침 후 확인해주세요.");
    }
    if (error.message.includes("SCAN_NOT_FOUND")) {
      throw new RbacError("해당 박스를 찾을 수 없습니다.");
    }

    throw new Error(error.message);
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const newScanId = String(row.scan_id);
  const finished = await finishRecordedScan(supabase, {
    scanId: newScanId,
    status: String(row.status),
    // 상품코드(GTIN)는 DB 함수가 새 박스로 옮겼다 — 여기서 다시 쓰지 않고 자동 생성 학습에만 쓰인다.
    gtin: null,
  });

  revalidatePath(REVALIDATE_PATH, "layout");
  revalidatePath("/dashboard/products");

  return {
    success: true,
    data: {
      scanId: newScanId,
      traceNo,
      status: finished.status as ReplaceTraceResult["status"],
      changed: true,
      autoCreatedProductName: finished.autoCreated?.productName ?? null,
      autoClosedDocument: finished.autoClosedDocument,
      failReason: finished.status === "EXCEPTION" ? lookup.failReason : null,
      failDetail: finished.status === "EXCEPTION" ? lookup.failDetail : null,
      failIsNotConfigured: finished.status === "EXCEPTION" && lookup.failIsNotConfigured,
    },
  };
}

/** 박스의 이력번호를 바로잡는다(사람이 새 번호를 넣음). 재고에 안 들어간 박스만. */
export async function replaceScanTraceNoAction(
  scanId: string,
  newTraceNo: string,
  confirmDuplicate = false
): Promise<ActionResult<ReplaceTraceResult | { duplicate: DuplicateWarning }>> {
  try {
    const { supabase, wholesalerId } = await resolveInboundScope();

    const { data: scan } = await supabase
      .from("inbound_scans")
      .select("trace_no")
      .eq("id", scanId)
      .eq("wholesaler_id", wholesalerId)
      .maybeSingle();

    if (!scan) {
      throw new RbacError("해당 박스를 찾을 수 없습니다.");
    }

    return await replaceTrace(supabase, {
      scanId,
      oldTraceNo: String(scan.trace_no),
      newTraceNo,
      confirmDuplicate,
    });
  } catch (error) {
    return toResult(error);
  }
}

/** 자동 재조회 한 번에 처리하는 박스 수, 같은 박스를 다시 조회하기까지의 간격(분) — 정부 API 호출 한도를 아낀다. */
const AUTO_RETRY_BATCH = 3;
const AUTO_RETRY_INTERVAL_MINUTES = 30;

/**
 * 이력조회 실패로 남은 박스를 시스템이 알아서 다시 조회한다. 입고 화면이 열려 있는 동안 몇 분마다 부른다.
 * 조회가 되면 상품 생성·재고 반영까지 이어지고, 여전히 못 찾으면 건드리지 않는다. 인증키가 없으면 헛호출하지 않는다.
 */
export async function retryUnresolvedScansAction(): Promise<ActionResult<{ checked: number; resolved: number }>> {
  try {
    const { supabase, wholesalerId } = await resolveInboundScope();
    const cutoff = new Date(Date.now() - AUTO_RETRY_INTERVAL_MINUTES * 60_000).toISOString();

    const { data: candidates } = await supabase
      .from("inbound_scans")
      .select("id, trace_no")
      .eq("wholesaler_id", wholesalerId)
      .eq("status", "EXCEPTION")
      .or(`lookup_retried_at.is.null,lookup_retried_at.lt.${cutoff}`)
      .order("created_at", { ascending: true })
      .limit(AUTO_RETRY_BATCH);

    const rows = (candidates ?? []) as Array<{ id: string; trace_no: string }>;

    if (rows.length === 0) {
      return { success: true, data: { checked: 0, resolved: 0 } };
    }

    await supabase.rpc("touch_scan_lookup_retry", { p_scan_ids: rows.map((row) => row.id) });

    let resolved = 0;

    for (const row of rows) {
      try {
        const result = await replaceTrace(supabase, {
          scanId: row.id,
          oldTraceNo: row.trace_no,
          newTraceNo: row.trace_no,
          confirmDuplicate: true,
        });
        const data = result.data as ReplaceTraceResult | undefined;

        if (result.success && data && "changed" in data && data.changed && data.status !== "EXCEPTION") resolved += 1;
      } catch (error) {
        // 다른 창이 먼저 처리했거나 형식이 안 맞는 번호 — 이 박스는 넘어간다.
        console.error(`[inbound] 자동 재조회 건너뜀 (${row.trace_no}):`, error instanceof Error ? error.message : error);
      }
    }

    return { success: true, data: { checked: rows.length, resolved } };
  } catch (error) {
    return toResult(error);
  }
}

/** 상품 미확정(PENDING_MAPPING)/예외 건에 상품을 지정해 재고로 확정한다. */
export interface MappingResult {
  /** 이력의 부위와 고른 상품의 부위가 다를 때 true (막지는 않는다) */
  partMismatch: boolean;
  tracePart: string | null;
  productPart: string | null;
}

export async function resolveMappingAction(
  scanId: string,
  productId: string,
  remember = true
): Promise<ActionResult<MappingResult>> {
  try {
    const { supabase } = await resolveInboundScope();

    const { data, error } = await supabase.rpc("resolve_inbound_mapping", {
      p_scan_id: scanId,
      p_product_id: productId,
      p_remember: remember,
    });

    if (error) {
      if (error.message.includes("PRODUCT_NOT_FOUND")) {
        throw new RbacError("선택한 상품을 찾을 수 없습니다.");
      }
      if (error.message.includes("SCAN_ALREADY_RESOLVED")) {
        throw new RbacError("이미 처리된 입고입니다. 새로고침 후 확인해주세요.");
      }

      throw new Error(error.message);
    }

    // 이 박스에 상품코드가 있었다면 "이 코드 = 이 상품"으로 기억한다.
    // 이력조회가 부위를 주지 않아 trace_product_map 학습이 안 걸리는 경우에도
    // 이쪽은 걸린다 — 실제로 되묻는 횟수를 줄여주는 건 이 경로다(30단계).
    if (remember) {
      const { error: learnError } = await supabase.rpc("learn_gtin_product", {
        p_scan_id: scanId,
        p_product_id: productId,
      });

      if (learnError) {
        console.error("[inbound] 상품코드 학습 실패:", learnError.message);
      }
    }

    await autoCloseDocumentsForScan(supabase, scanId);

    revalidatePath(REVALIDATE_PATH, "layout");
    revalidatePath("/dashboard/products");

    const row = (data ?? {}) as Record<string, unknown>;

    return {
      success: true,
      data: {
        partMismatch: Boolean(row.part_mismatch),
        tracePart: (row.trace_part as string | null) ?? null,
        productPart: (row.product_part as string | null) ?? null,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 상품 미확정/예외 건을 상품 지정과 동시에 특정 주문으로 배정한다.
 *
 * 고객이 미리 요청해서 들어온, 공공 API에 없는 공급자 자체 묶음 같은 경우를 위한 경로다.
 * "상품 지정 → 주문 확정 대기 → 출고 스캔"을 화면 세 개로 오가지 않고 한 번에 끝낸다.
 * DB가 resolve_inbound_mapping + record_outbound_scan을 한 트랜잭션으로 묶어서
 * 실행하므로, 뒤쪽(주문 배정)이 실패하면 앞쪽(상품 지정)도 함께 롤백된다.
 */
export interface ResolveToOrderResult extends MappingResult {
  taken: number;
  remainingNeeded: number;
}

export async function resolveMappingToOrderAction(
  scanId: string,
  productId: string,
  orderId: string,
  remember = true
): Promise<ActionResult<ResolveToOrderResult>> {
  try {
    const { supabase } = await resolveInboundScope();

    const { data, error } = await supabase.rpc("resolve_inbound_mapping_to_order", {
      p_scan_id: scanId,
      p_product_id: productId,
      p_order_id: orderId,
      p_remember: remember,
    });

    if (error) {
      if (error.message.includes("PRODUCT_NOT_FOUND")) {
        throw new RbacError("선택한 상품을 찾을 수 없습니다.");
      }
      if (error.message.includes("SCAN_ALREADY_RESOLVED")) {
        throw new RbacError("이미 처리된 입고입니다. 새로고침 후 확인해주세요.");
      }
      if (error.message.includes("ORDER_NOT_FOUND")) {
        throw new RbacError("발주서를 찾을 수 없습니다.");
      }
      if (error.message.includes("ORDER_NOT_SHIPPABLE")) {
        throw new RbacError("확정 또는 배송중 상태의 발주서만 배정할 수 있습니다.");
      }
      if (error.message.includes("PRODUCT_NOT_IN_ORDER")) {
        throw new RbacError("고른 주문에 이 상품이 없습니다. 상품이나 주문을 다시 확인해주세요.");
      }
      if (error.message.includes("PRODUCT_ALREADY_FULFILLED")) {
        throw new RbacError("이 주문은 해당 상품 수량을 이미 다 채웠습니다.");
      }

      const expired = error.message.match(/BOX_EXPIRED:(\d{4}-\d{2}-\d{2})/);
      if (expired) {
        throw new RbacError(`유통기한이 지난 박스입니다 (${expired[1]}). 배정할 수 없습니다.`);
      }

      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH, "layout");
    revalidatePath("/dashboard/products");
    revalidatePath("/dashboard/outbound");

    const row = (data ?? {}) as Record<string, unknown>;
    const resolveRow = (row.resolve ?? {}) as Record<string, unknown>;
    const outboundRow = (row.outbound ?? {}) as Record<string, unknown>;

    return {
      success: true,
      data: {
        partMismatch: Boolean(resolveRow.part_mismatch),
        tracePart: (resolveRow.trace_part as string | null) ?? null,
        productPart: (resolveRow.product_part as string | null) ?? null,
        taken: Number(outboundRow.taken ?? 0),
        remainingNeeded: Number(outboundRow.remaining_needed ?? 0),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

export interface VoidScanResult {
  /** 이 박스가 이어져 있던 전표가 이미 마감돼 있어서 다시 열었다(안 온 줄이 생겨 사무실이 알아야 한다). 다시 열자마자 저절로 재마감되면 false. */
  reopenedDocument: boolean;
}

/** 박스가 이어진 전표가 마감 상태면 그 전표 id. 취소하면 이어짐이 풀리므로 취소 전에 미리 봐 둔다. */
async function closedDocumentOfScan(supabase: Client, scanId: string): Promise<string | null> {
  const { data: link } = await supabase.from("inbound_document_line_scans").select("line_id").eq("scan_id", scanId).maybeSingle();

  if (!link) return null;

  const { data: line } = await supabase.from("inbound_document_lines").select("document_id").eq("id", link.line_id).maybeSingle();

  if (!line) return null;

  const { data: doc } = await supabase.from("inbound_documents").select("id, status").eq("id", line.document_id).maybeSingle();

  return doc?.status === "CLOSED" ? String(doc.id) : null;
}

/**
 * 오스캔 취소 — 삭제가 아니라 역분개로 처리된다.
 * 마감된 전표의 박스를 취소하면 그 줄이 "안 온 것"이 되는데 전표는 마감 그대로라 아무도 모르게 어긋난다 —
 * 그래서 전표를 저절로 다시 열고, 그래도 다 채워진 상태(더 온 박스를 취소한 경우)면 곧바로 다시 마감한다.
 */
export async function voidScanAction(scanId: string, reason?: string): Promise<ActionResult<VoidScanResult>> {
  try {
    const { supabase } = await resolveInboundScope();
    const closedDocumentId = await closedDocumentOfScan(supabase, scanId);

    const { error } = await supabase.rpc("void_inbound_scan", {
      p_scan_id: scanId,
      p_reason: reason?.trim() || null,
    });

    if (error) {
      if (error.message.includes("PARTIALLY_SHIPPED")) {
        throw new RbacError("이미 일부가 출고된 입고는 취소할 수 없습니다.");
      }
      if (error.message.includes("ALREADY_VOIDED")) {
        throw new RbacError("이미 취소된 입고입니다.");
      }

      throw new Error(error.message);
    }

    let reopenedDocument = false;

    if (closedDocumentId) {
      const { error: reopenError } = await supabase.rpc("reopen_inbound_document", { p_document_id: closedDocumentId });

      if (reopenError) {
        console.error("[inbound] 취소 뒤 전표 다시 열기 실패:", reopenError.message);
      } else {
        reopenedDocument = (await autoCloseDocuments(supabase, [closedDocumentId])).length === 0;
      }
    }

    await autoCloseDocumentsForScan(supabase, scanId);

    revalidatePath(REVALIDATE_PATH, "layout");
    revalidatePath("/dashboard/products");

    return { success: true, data: { reopenedDocument } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 엑셀 대량 입고
//
// Vercel Hobby는 크론이 2개(이미 소진)뿐이고 하루 1회라 큐를 배치로 소화할 수
// 없다. 그래서 브라우저가 청크를 반복 호출하는 구조로 간다 — 요청 하나가 짧아
// 실행시간 제한을 안 건드리고, 진행률이 보이며, 창을 닫아도 job이 DB에 남아
// 이어서 처리된다.
// ====================================================================

export interface ImportJobProgress {
  jobId: string;
  total: number;
  done: number;
  failed: number;
  finished: boolean;
}

/** 한 번 호출에서 쓸 시간 예산. 이력 조회가 붙은 행은 느려서 건수보다 시간으로 끊는다. */
const CHUNK_TIME_BUDGET_MS = 6_000;

/** 시간 예산 안이라도 이만큼 처리하면 한 번 끊고 진행률을 갱신한다. */
const CHUNK_MAX_ROWS = 25;

/** inbound_scans(import_row_id) 유니크 인덱스 이름 — 위반 메시지에 그대로 실려 온다. */
const IMPORT_ROW_UNIQUE_INDEX = "idx_inbound_scans_import_row_unique";

/** 다른 창이 같은 행을 먼저 처리했을 때의 표식. 행 상태를 덮어쓰지 않는다. */
const IMPORT_ROW_ALREADY_PROCESSED = "이미 다른 창에서 처리된 행입니다.";

/** 상태별 행 수를 DB에서 다시 센다 — 창이 둘 이상이면 로컬 증가분은 믿을 수 없다. */
async function countImportRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  jobId: string
): Promise<{ done: number; failed: number }> {
  const [{ count: done }, { count: failed }] = await Promise.all([
    supabase
      .from("inbound_import_rows")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("status", "DONE"),
    supabase
      .from("inbound_import_rows")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("status", "FAILED"),
  ]);

  return { done: done ?? 0, failed: failed ?? 0 };
}

export async function createImportJobAction(input: {
  fileName: string;
  rows: Array<{ rowNo: number; traceNo: string; weight: number }>;
}): Promise<ActionResult<ImportJobProgress>> {
  try {
    const { supabase, wholesalerId, context } = await resolveInboundScope();

    const rows = input.rows.filter((row) => row.traceNo && row.weight > 0);

    if (rows.length === 0) {
      throw new RbacError("처리할 행이 없습니다.");
    }

    if (rows.length > 5_000) {
      throw new RbacError("한 번에 5,000행까지만 올릴 수 있습니다. 파일을 나눠주세요.");
    }

    const { data: job, error: jobError } = await supabase
      .from("inbound_import_jobs")
      .insert({
        wholesaler_id: wholesalerId,
        file_name: input.fileName.slice(0, 200),
        total_rows: rows.length,
        status: "PENDING",
        created_by: context.userId,
      })
      .select("id")
      .single();

    if (jobError || !job) {
      throw new Error(jobError?.message ?? "업로드 작업을 만들지 못했습니다.");
    }

    const { error: rowsError } = await supabase.from("inbound_import_rows").insert(
      rows.map((row) => ({
        job_id: job.id as string,
        row_no: row.rowNo,
        trace_no: row.traceNo,
        weight: row.weight,
      }))
    );

    if (rowsError) {
      throw new Error(rowsError.message);
    }

    return {
      success: true,
      data: { jobId: job.id as string, total: rows.length, done: 0, failed: 0, finished: false },
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 대기 중인 행을 시간 예산만큼 처리한다. 브라우저가 finished가 될 때까지 반복 호출한다.
 *
 * 개별 스캔과 달리 중복 확인창을 띄울 수 없으므로(행마다 물어볼 수 없다)
 * DB 쪽에서 EXCEL 경로는 중복 검사를 건너뛴다.
 */
export async function processImportChunkAction(
  jobId: string
): Promise<ActionResult<ImportJobProgress>> {
  try {
    const { supabase, wholesalerId } = await resolveInboundScope();

    const { data: job } = await supabase
      .from("inbound_import_jobs")
      .select("id, wholesaler_id, total_rows, done_rows, failed_rows, status")
      .eq("id", jobId)
      .maybeSingle();

    if (!job || job.wholesaler_id !== wholesalerId) {
      throw new RbacError("업로드 작업을 찾을 수 없습니다.");
    }

    const { data: pendingRows } = await supabase
      .from("inbound_import_rows")
      .select("id, row_no, trace_no, weight")
      .eq("job_id", jobId)
      .eq("status", "PENDING")
      .order("row_no", { ascending: true })
      .limit(CHUNK_MAX_ROWS);

    const rows = (pendingRows ?? []) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      const counts = await countImportRows(supabase, jobId);

      await supabase
        .from("inbound_import_jobs")
        .update({
          done_rows: counts.done,
          failed_rows: counts.failed,
          status: "DONE",
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      return {
        success: true,
        data: { jobId, total: Number(job.total_rows), ...counts, finished: true },
      };
    }

    const startedAt = Date.now();

    for (const row of rows) {
      // 시간 예산을 넘기면 남은 행은 다음 호출로 넘긴다.
      if (Date.now() - startedAt > CHUNK_TIME_BUDGET_MS) {
        break;
      }

      const rowId = String(row.id);
      const traceNo = String(row.trace_no);
      const result = await recordScanAction({
        traceNo,
        weight: Number(row.weight),
        scanType: "EXCEL",
        confirmDuplicate: true,
        importRowId: rowId,
      });

      const scanned = result.success && result.data && "scanId" in result.data ? result.data : null;

      // 다른 창이 이 행을 먼저 입고시켰으면(유니크 위반) 그쪽이 상태를 쓰게 두고 지나간다.
      if (!scanned && result.error === IMPORT_ROW_ALREADY_PROCESSED) {
        continue;
      }

      // 아래 갱신은 전부 PENDING일 때만 — 같은 행을 두 창이 겹쳐 처리해도
      // 먼저 쓴 DONE을 나중 FAILED가 덮어쓰지 않는다(전표 사전조회와 같은 방식).
      if (scanned) {
        await supabase
          .from("inbound_import_rows")
          .update({ status: "DONE", scan_id: scanned.scanId, error_detail: null })
          .eq("id", rowId)
          .eq("status", "PENDING");
      } else {
        await supabase
          .from("inbound_import_rows")
          .update({ status: "FAILED", error_detail: result.error ?? "처리 실패" })
          .eq("id", rowId)
          .eq("status", "PENDING");
      }
    }

    const { done, failed } = await countImportRows(supabase, jobId);

    await supabase
      .from("inbound_import_jobs")
      .update({
        done_rows: done,
        failed_rows: failed,
        status: "PROCESSING",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    const finished = done + failed >= Number(job.total_rows);

    revalidatePath(REVALIDATE_PATH, "layout");

    return {
      success: true,
      data: { jobId, total: Number(job.total_rows), done, failed, finished },
    };
  } catch (error) {
    return toResult(error);
  }
}

/** 새로고침 후 이어서 처리할 미완료 작업을 찾는다. */
export async function findUnfinishedImportJobAction(): Promise<ActionResult<ImportJobProgress | null>> {
  try {
    const { supabase, wholesalerId } = await resolveInboundScope();

    const { data } = await supabase
      .from("inbound_import_jobs")
      .select("id, total_rows, done_rows, failed_rows")
      .eq("wholesaler_id", wholesalerId)
      .in("status", ["PENDING", "PROCESSING"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      return { success: true, data: null };
    }

    return {
      success: true,
      data: {
        jobId: data.id as string,
        total: Number(data.total_rows),
        done: Number(data.done_rows),
        failed: Number(data.failed_rows),
        finished: false,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/** 스캔 화면에서 "이력 조회가 켜져 있는지" 안내하기 위한 상태. */
export async function getInboundConfigAction(): Promise<ActionResult<{ traceLookupEnabled: boolean }>> {
  try {
    await resolveInboundScope();

    return { success: true, data: { traceLookupEnabled: isMtraceConfigured() } };
  } catch (error) {
    return toResult(error);
  }
}

/** 위치 사진 한 장 한도 — 참고용이라 전표 파일보다 훨씬 작게 잡는다. */
const MAX_LOCATION_PHOTO_BYTES = 4 * 1024 * 1024;

/**
 * 보관 위치 지정(선택) — 입고 시점이 아니어도 언제든 나중에 채울 수 있다
 * (2026-09-24, "시간 되면" 지정). 텍스트는 업체마다 자유 형식이고, 사진은
 * 참고용(사람이 보고 알아보는 용도, AI 인식 아님)이라 완전히 선택사항이다.
 *
 * 사진 업로드가 실패해도 위치 이름은 그대로 저장한다 — 사진은 덤이지 필수가
 * 아니다. 기존 사진을 지우지 않으려면(사진 없이 이름만 고칠 때) photoPath를
 * undefined로 두고, 사진 자체를 지우려면 formData에 파일을 안 실은 채
 * clearPhoto=true를 같이 보낸다.
 */
export async function setScanStorageLocationAction(
  formData: FormData
): Promise<ActionResult<{ photoPath: string | null; photoWarning: string | null }>> {
  try {
    const { supabase, wholesalerId } = await resolveInboundScope();

    const scanId = String(formData.get("scanId") ?? "");
    const location = String(formData.get("location") ?? "");
    const clearPhoto = formData.get("clearPhoto") === "true";

    if (!scanId) {
      throw new RbacError("입고 건을 찾을 수 없습니다.");
    }

    let photoPath: string | null = null;
    let photoWarning: string | null = null;
    const file = formData.get("photo");

    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_LOCATION_PHOTO_BYTES) {
        photoWarning = "사진이 너무 큽니다(4MB 이하). 위치 이름만 저장했습니다.";
      } else {
        const safeName = file.name.replace(/[^\w.\-가-힣]/g, "_").slice(-80) || "location.jpg";
        const path = `${wholesalerId}/${scanId}/${Date.now()}_${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from("scan-location-photos")
          .upload(path, Buffer.from(await file.arrayBuffer()), {
            contentType: file.type || "image/jpeg",
            upsert: true,
          });

        if (uploadError) {
          photoWarning = "사진 업로드에 실패했습니다. 위치 이름만 저장했습니다.";
        } else {
          photoPath = path;
        }
      }
    }

    const { data, error } = await supabase.rpc("set_scan_storage_location", {
      p_scan_id: scanId,
      p_location: location,
      // 사진을 새로 안 올렸으면(그리고 지우라는 것도 아니면) 기존 값을 건드리지
      // 않는다 — RPC에 NULL을 그냥 넘기면 기존 사진이 지워지므로, 그 경우만
      // 별도 처리(clearPhoto 또는 새 업로드 성공)에서 photoPath를 채운다.
      p_photo_path: photoPath,
      p_keep_existing_photo: !clearPhoto && photoPath === null,
    });

    if (error) throw new Error(error.message);

    if (!data) {
      throw new RbacError("해당 입고 건을 찾을 수 없습니다.");
    }

    revalidatePath(REVALIDATE_PATH, "layout");

    return { success: true, data: { photoPath, photoWarning } };
  } catch (error) {
    return toResult(error);
  }
}

/** 위치 참고 사진 열람용 서명 링크 — 비공개 버킷이라 매번 새로 발급한다. */
export async function getScanLocationPhotoUrlAction(
  photoPath: string
): Promise<ActionResult<string>> {
  try {
    const { supabase } = await resolveInboundScope();

    const { data, error } = await supabase.storage
      .from("scan-location-photos")
      .createSignedUrl(photoPath, 60 * 5);

    if (error || !data) {
      throw new RbacError("사진 링크를 만들지 못했습니다.");
    }

    return { success: true, data: data.signedUrl };
  } catch (error) {
    return toResult(error);
  }
}
