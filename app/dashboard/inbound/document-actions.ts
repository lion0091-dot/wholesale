"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { parseBarcode } from "@/lib/livestock/barcode-parser";
import {
  extractGroupMemberTraceNos,
  fetchTraceRecord,
  isMtraceConfigured,
  isPlausibleTraceNo,
  MtraceNotConfiguredError,
} from "@/lib/livestock/mtrace-client";

/**
 * 공급처 원본 명세서 저장 (29단계 A).
 *
 * 읽기·확인은 전부 브라우저에서 끝내고, 여기서는 사람이 확인한 결과만 받는다.
 * 파싱을 서버에서 하지 않는 이유는 틀리게 읽은 값이 그대로 저장되면 안 되기
 * 때문이다 — 화면에서 고친 최종본만 들어온다.
 *
 * 재고를 만들지 않는다. 재고는 박스 스캔만이 만든다(잠긴 결정).
 */

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/inbound";

/** 입고와 같은 기준 — 현장 작업이라 staff까지 허용한다. */
const DOCUMENT_ROLES: OrgRole[] = ["owner", "manager", "staff"];

/** 서버 액션 본문 한도(next.config의 bodySizeLimit)와 맞춘다. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface DocumentLineInput {
  lineNo: number;
  raw?: string | null;
  itemName?: string | null;
  productId?: string | null;
  traceNo?: string | null;
  partName?: string | null;
  grade?: string | null;
  origin?: string | null;
  quantity?: number | null;
  labeledWeight?: number | null;
  unitPrice?: number | null;
  amount?: number | null;
}

export interface SaveDocumentInput {
  supplierName: string;
  documentNo?: string | null;
  issuedOn?: string | null;
  totalAmount?: number | null;
  note?: string | null;
  entryMethod: "AUTO" | "MANUAL";
  /** 사람이 확정한 칸 위치. 같은 공급처 서류를 다음에 읽을 때 재사용한다. */
  columnMap?: Record<string, number> | null;
  sampleHeader?: string | null;
  lines: DocumentLineInput[];
}

export interface SavedDocument {
  documentId: string;
  lineCount: number;
  /** 원본 파일까지 보관됐는지 — 실패해도 저장 자체는 살린다. */
  fileStored: boolean;
  /**
   * 이력/로트번호 사전조회 대상 줄 수. 0보다 크면 화면이 processDocumentPrelookupChunkAction을
   * finished될 때까지 반복 호출해야 한다(실물 도착 전에 미리 걸러 공급처에 등록을
   * 요청하기 위함, 사장님 지침 2026-09-24).
   *
   * 저장 액션 안에서 직접 조회하지 않는 이유: 로트 번호는 그 안의 개체번호까지
   * 하나하나 재확인하므로, 줄이 많으면(로트 20+이력 100 같은 경우) 정부 API 호출이
   * 300건대로 불어나 하나의 서버 액션 실행시간 제한(Vercel Hobby)을 넘길 위험이
   * 크다 — 엑셀 대량 입고에서 같은 문제를 이미 겪어 청크 처리로 바꾼 전례가 있다
   * (20260930000096 마이그레이션 참고).
   */
  pendingPrelookupCount: number;
}

export interface DocumentPrelookupProgress {
  documentId: string;
  /** 조회 대상 줄 총합(NULL 제외) */
  total: number;
  done: number;
  failed: number;
  finished: boolean;
  /** 정부 이력조회에서 확인 안 된 이력/로트번호 — 공급처 확인 요청 문구에 쓴다 */
  failedTraceNos: string[];
}

/**
 * 이력/로트번호가 master_livestock에 이미 있는지 보고, 없으면 지금 조회해서
 * 채워둔다. 실제 검수(스캔)에서 쓰는 것과 같은 조회+저장 절차다(actions.ts의
 * recordInboundScanAction 안 로직과 동일 패턴) — 다만 여기는 스캔 전에 서류만
 * 갖고 미리 하는 것이라 실패해도 서류 저장 자체를 막지 않는다.
 */
async function ensureTraceCached(
  supabase: Awaited<ReturnType<typeof createClient>>,
  traceNo: string
): Promise<{ found: boolean; notConfigured: boolean; unregisteredMembers: string[] }> {
  const { data: cached } = await supabase
    .from("master_livestock")
    .select("trace_no")
    .eq("trace_no", traceNo)
    .maybeSingle();

  if (cached) {
    return { found: true, notConfigured: false, unregisteredMembers: [] };
  }

  if (!isMtraceConfigured()) {
    return { found: false, notConfigured: true, unregisteredMembers: [] };
  }

  try {
    const record = await fetchTraceRecord(traceNo);

    if (!record) {
      return { found: false, notConfigured: false, unregisteredMembers: [] };
    }

    const { error: upsertError } = await supabase.rpc("upsert_master_livestock", {
      p_trace_no: record.traceNo,
      p_trace_kind: record.traceKind,
      p_source: record.source,
      p_raw_payload: record.rawPayload,
      p_species: record.species,
      p_species_group: record.speciesGroup,
      p_part_name: record.partName,
      p_grade: record.grade,
      p_slaughter_date: record.slaughterDate,
      p_butchery_place: record.butcheryPlace,
      p_farm_name: record.farmName,
      p_origin_country: record.originCountry,
      p_importer_name: record.importerName,
      p_packing_date: record.packingDate,
    });

    if (upsertError) {
      console.error("[inbound-document] 이력 캐시 저장 실패:", upsertError.message);
      return { found: false, notConfigured: false, unregisteredMembers: [] };
    }

    // 로트면 "조회가 됐다"에서 끝내지 않는다 — 그 안에 적힌 개체번호 하나하나가
    // 실제로 등록돼 있는지 다시 확인한다(사장님 지침 2026-09-24: 로트로 조회되고,
    // 조회결과에 이력번호가 있고, 그 이력번호로도 조회가 돼야 한다). 가공장이
    // 로트 구성내역을 잘못 입력해 허위/누락 번호가 섞이는 경우가 실제로 흔하다.
    let unregisteredMembers: string[] = [];

    if (record.traceKind === "group") {
      const memberTraceNos = extractGroupMemberTraceNos(record.rawPayload);

      const memberChecks = await Promise.all(
        memberTraceNos.map(async (memberTraceNo) => {
          try {
            return { memberTraceNo, ok: (await fetchTraceRecord(memberTraceNo)) !== null };
          } catch (error) {
            // 개체 조회 자체가 실패해도(네트워크 등 일시적 오류) "등록 안 됨"으로
            // 단정하지 않는다 — 로트 조회는 이미 성공했으니 진짜 미등록인지 재시도로
            // 확인할 여지를 남긴다.
            console.error(
              `[inbound-document] 로트 ${traceNo}의 개체 ${memberTraceNo} 재확인 실패:`,
              error instanceof Error ? error.message : String(error)
            );
            return { memberTraceNo, ok: true };
          }
        })
      );

      unregisteredMembers = memberChecks.filter((check) => !check.ok).map((check) => check.memberTraceNo);
    }

    return { found: true, notConfigured: false, unregisteredMembers };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[inbound-document] ${traceNo} 사전 이력 조회 실패:`, message);
    return {
      found: false,
      notConfigured: error instanceof MtraceNotConfiguredError,
      unregisteredMembers: [],
    };
  }
}

/**
 * 이 값이 사전조회 대상인지 — 정부가 실제로 조회해줄 수 있는 형태인지만 본다.
 * 우리가 발행한 세트번호(SET-YYMMDD-NNN)는 정부 조회 대상이 아니라 제외한다.
 */
function isEligibleForPrelookup(value: string | null | undefined): boolean {
  const trimmed = value?.trim().toUpperCase() ?? "";

  return trimmed.length > 0 && isPlausibleTraceNo(trimmed) && parseBarcode(trimmed).format !== "bundle";
}

/** 한 번 청크 호출에서 쓸 시간 예산. 로트 줄은 개체 재확인까지 붙어 느리므로 건수보다 시간으로 끊는다. */
const PRELOOKUP_CHUNK_TIME_BUDGET_MS = 6_000;

/** 시간 예산 안이라도 이만큼 처리하면 한 번 끊고 진행률을 갱신한다. */
const PRELOOKUP_CHUNK_MAX_ROWS = 20;

/** 로트 구성원 미등록 에러 메시지 접두사. 기록할 때와 되읽을 때 같은 문구를 써야 한다. */
const LOT_MEMBER_MISSING_PREFIX = "로트 구성원 미등록: ";

/**
 * 서류 취소로 조회를 건너뛴 줄에 남기는 표식.
 *
 * prelookup_status는 PENDING/DONE/FAILED만 허용돼(CHECK 제약) 별도 CANCELLED
 * 상태를 새로 만들 수 없다 — FAILED에 이 문구를 얹어 구분한다. 되살리면(복원)
 * 이 표식이 붙은 줄만 골라 다시 PENDING으로 돌린다.
 */
const DISCARD_SKIPPED_PRELOOKUP_ERROR = "서류 취소로 조회를 건너뜀";

/**
 * 화면/공급처 요청 문구에 보여줄 실패 이력번호를 뽑는다.
 *
 * 로트 구성원 미등록 실패는 로트 자체(row.trace_no)는 정상 조회됐고 그 안의
 * 특정 개체번호만 미등록인 경우다 — 그대로 로트번호를 보여주면 이미 등록된
 * 번호를 확인해달라는 잘못된 안내가 된다. 에러 메시지에 적어둔 실제 미등록
 * 개체번호를 대신 보여준다.
 */
function extractFailedTraceNos(row: { trace_no: string | null; prelookup_error: string | null }): string[] {
  if (row.prelookup_error?.startsWith(LOT_MEMBER_MISSING_PREFIX)) {
    return row.prelookup_error
      .slice(LOT_MEMBER_MISSING_PREFIX.length)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return row.trace_no ? [row.trace_no] : [];
}

async function loadPrelookupProgress(
  supabase: Awaited<ReturnType<typeof createClient>>,
  documentId: string
): Promise<Omit<DocumentPrelookupProgress, "documentId">> {
  const { data } = await supabase
    .from("inbound_document_lines")
    .select("prelookup_status, trace_no, prelookup_error")
    .eq("document_id", documentId)
    .not("prelookup_status", "is", null);

  const rows = (data ?? []) as Array<{
    prelookup_status: string;
    trace_no: string | null;
    prelookup_error: string | null;
  }>;
  const done = rows.filter((row) => row.prelookup_status === "DONE").length;
  const failedRows = rows.filter((row) => row.prelookup_status === "FAILED");

  return {
    total: rows.length,
    done,
    failed: failedRows.length,
    finished: done + failedRows.length >= rows.length,
    failedTraceNos: [...new Set(failedRows.flatMap(extractFailedTraceNos))],
  };
}

/**
 * 대기 중인 명세서 줄을 시간 예산만큼 순차로(Promise.all 아님) 조회한다.
 * 브라우저가 finished가 될 때까지 반복 호출한다 — 엑셀 대량 입고의
 * processImportChunkAction과 같은 패턴(app/dashboard/inbound/actions.ts).
 *
 * 순차로 도는 이유: 로트 하나 조회는 그 안 개체번호까지 내부적으로 병렬 재확인을
 * 이미 하므로(ensureTraceCached), 줄까지 병렬로 겹치면 정부 API에 순간적으로 너무
 * 많은 동시 요청이 나간다. 시간이 걸리더라도 보수적으로 한 줄씩 처리한다.
 */
export async function processDocumentPrelookupChunkAction(
  documentId: string
): Promise<ActionResult<DocumentPrelookupProgress>> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();

    const { data: doc } = await supabase
      .from("inbound_documents")
      .select("id, wholesaler_id")
      .eq("id", documentId)
      .maybeSingle();

    if (!doc || (doc.wholesaler_id as string) !== wholesalerId) {
      throw new RbacError("명세서를 찾을 수 없습니다.");
    }

    const { data: pendingLines } = await supabase
      .from("inbound_document_lines")
      .select("id, trace_no")
      .eq("document_id", documentId)
      .eq("prelookup_status", "PENDING")
      .order("line_no", { ascending: true })
      .limit(PRELOOKUP_CHUNK_MAX_ROWS);

    const rows = (pendingLines ?? []) as Array<{ id: string; trace_no: string | null }>;
    const startedAt = Date.now();

    for (const row of rows) {
      if (Date.now() - startedAt > PRELOOKUP_CHUNK_TIME_BUDGET_MS) {
        break;
      }

      const traceNo = (row.trace_no ?? "").trim().toUpperCase();

      // 아래 update들은 전부 .eq("prelookup_status", "PENDING")로 걸어서, 같은 줄을
      // 두 요청(탭 두 개 등)이 동시에 처리해도 나중 응답이 먼저 응답을 덮어쓰지
      // 않게 한다(정부 API 중복 호출 자체는 막지 못하지만 최종 기록은 안전하다).
      try {
        const check = await ensureTraceCached(supabase, traceNo);

        if (check.notConfigured) {
          // 인증키 미설정은 공급처 잘못이 아니다 — 재시도해도 의미 없으니 DONE으로 넘긴다.
          await supabase
            .from("inbound_document_lines")
            .update({ prelookup_status: "DONE", prelookup_error: null })
            .eq("id", row.id)
            .eq("prelookup_status", "PENDING");
        } else if (check.found && check.unregisteredMembers.length === 0) {
          await supabase
            .from("inbound_document_lines")
            .update({ prelookup_status: "DONE", prelookup_error: null })
            .eq("id", row.id)
            .eq("prelookup_status", "PENDING");
        } else if (check.found) {
          await supabase
            .from("inbound_document_lines")
            .update({
              prelookup_status: "FAILED",
              prelookup_error: `${LOT_MEMBER_MISSING_PREFIX}${check.unregisteredMembers.join(", ")}`,
            })
            .eq("id", row.id)
            .eq("prelookup_status", "PENDING");
        } else {
          await supabase
            .from("inbound_document_lines")
            .update({ prelookup_status: "FAILED", prelookup_error: "정부 이력조회에서 확인되지 않음" })
            .eq("id", row.id)
            .eq("prelookup_status", "PENDING");
        }
      } catch (error) {
        await supabase
          .from("inbound_document_lines")
          .update({
            prelookup_status: "FAILED",
            prelookup_error: error instanceof Error ? error.message : "조회 실패",
          })
          .eq("id", row.id)
          .eq("prelookup_status", "PENDING");
      }
    }

    const progress = await loadPrelookupProgress(supabase, documentId);
    revalidatePath(REVALIDATE_PATH);

    return { success: true, data: { documentId, ...progress } };
  } catch (error) {
    return toResult(error);
  }
}

/** 실패한 줄을 다시 대기 상태로 돌려 재시도 대상에 올린다. */
export async function retryDocumentPrelookupAction(
  documentId: string
): Promise<ActionResult<{ retried: number }>> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();

    const { data: doc } = await supabase
      .from("inbound_documents")
      .select("id, wholesaler_id")
      .eq("id", documentId)
      .maybeSingle();

    if (!doc || (doc.wholesaler_id as string) !== wholesalerId) {
      throw new RbacError("명세서를 찾을 수 없습니다.");
    }

    const { data, error } = await supabase
      .from("inbound_document_lines")
      .update({ prelookup_status: "PENDING", prelookup_error: null })
      .eq("document_id", documentId)
      .eq("prelookup_status", "FAILED")
      .select("id");

    if (error) {
      throw error;
    }

    revalidatePath(REVALIDATE_PATH);

    return { success: true, data: { retried: (data ?? []).length } };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 새로고침/이탈 후 다시 들어왔을 때 이어서 처리할 미완료 사전조회가 있는지 찾는다.
 * inbound_document_lines의 RLS가 이미 document_id를 통해 소유 문서로만 좁혀주므로
 * 여기서 별도로 wholesaler_id를 다시 확인할 필요가 없다.
 */
export async function findUnfinishedDocumentPrelookupAction(): Promise<
  ActionResult<DocumentPrelookupProgress | null>
> {
  try {
    await resolveDocumentScope();
    const supabase = await createClient();

    const { data } = await supabase
      .from("inbound_document_lines")
      .select("document_id")
      .eq("prelookup_status", "PENDING")
      .limit(1)
      .maybeSingle();

    if (!data) {
      return { success: true, data: null };
    }

    const documentId = String(data.document_id);
    const progress = await loadPrelookupProgress(supabase, documentId);

    return { success: true, data: { documentId, ...progress } };
  } catch (error) {
    return toResult(error);
  }
}

async function resolveDocumentScope() {
  const context = await requireOrgRole(DOCUMENT_ROLES);
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

  // super_admin은 조직 소속이 없는 한 자기 profile_id로 업체를 매칭하지 않는다
  // (actions.ts의 resolveInboundScope와 같은 판단).
  if (!wholesalerId && !context.isSuperAdmin) {
    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("id")
      .eq("profile_id", context.userId)
      .maybeSingle();

    wholesalerId = (wholesaler?.id as string | null) ?? null;
  }

  if (!wholesalerId) {
    throw new RbacError("공급사 업체 정보가 없어 명세서를 저장할 수 없습니다.");
  }

  return { supabase, context, wholesalerId };
}

/** 대소문자·공백 차이로 공급처 학습이 갈라지지 않게 맞춘다. */
function supplierKeyOf(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  console.error("[inbound-document]", error);

  return { success: false, error: "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." };
}

export async function saveInboundDocumentAction(
  formData: FormData
): Promise<ActionResult<SavedDocument>> {
  try {
    const { supabase, context, wholesalerId } = await resolveDocumentScope();

    const rawPayload = formData.get("payload");

    if (typeof rawPayload !== "string") {
      throw new RbacError("저장할 내용이 없습니다.");
    }

    const input = JSON.parse(rawPayload) as SaveDocumentInput;
    const supplierName = (input.supplierName ?? "").trim();

    if (!supplierName) {
      throw new RbacError("공급처 이름을 입력해주세요.");
    }

    // 품목 줄이 없어도 저장한다 — 사진이나 스캔본처럼 글자를 못 읽는 서류는
    // 원본 보관만이 목적이다(잠긴 결정: 읽을 수 없는 문서를 입고 화면에서
    // 손으로 받아적게 만들지 않는다).
    const lines = Array.isArray(input.lines) ? input.lines : [];
    const file = formData.get("file");
    const hasFile = file instanceof File && file.size > 0;

    if (hasFile && file.size > MAX_FILE_BYTES) {
      throw new RbacError("파일이 너무 큽니다. 8MB 이하로 올려주세요.");
    }

    if (lines.length === 0 && !hasFile) {
      throw new RbacError("저장할 품목도 파일도 없습니다.");
    }

    const { data: created, error: insertError } = await supabase
      .from("inbound_documents")
      .insert({
        wholesaler_id: wholesalerId,
        supplier_name: supplierName,
        document_no: input.documentNo?.trim() || null,
        issued_on: input.issuedOn || null,
        total_amount: input.totalAmount ?? null,
        note: input.note?.trim() || null,
        entry_method: input.entryMethod === "MANUAL" ? "MANUAL" : "AUTO",
        file_name: hasFile ? file.name : null,
        mime_type: hasFile ? file.type || null : null,
        // 읽어낸 품목이 있으면 바로 대조 대상(PENDING), 원본만 보관한 서류는
        // 아직 내용이 안 들어간 상태(DRAFT)로 둔다.
        status: lines.length > 0 ? "PENDING" : "DRAFT",
        created_by: context.userId,
      })
      .select("id")
      .single();

    if (insertError || !created) {
      throw insertError ?? new Error("문서 저장 실패");
    }

    const documentId = String(created.id);

    // 원본 파일 보관. 경로 첫 칸이 업체 UUID여야 Storage 정책을 통과한다.
    let fileStored = false;

    if (hasFile) {
      const safeName = file.name.replace(/[^\w.\-가-힣]/g, "_").slice(-120);
      const path = `${wholesalerId}/${documentId}/${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from("inbound-documents")
        .upload(path, Buffer.from(await file.arrayBuffer()), {
          contentType: file.type || "application/octet-stream",
          upsert: true,
        });

      if (uploadError) {
        // 원본 보관에 실패해도 읽어낸 내용은 살린다 — 다시 올릴 수 있게 안내만 한다.
        console.error("[inbound-document] 원본 보관 실패", uploadError);
      } else {
        fileStored = true;
        await supabase
          .from("inbound_documents")
          .update({ storage_path: path })
          .eq("id", documentId);
      }
    }

    // 같은 이력/로트번호가 여러 줄에 걸쳐 나오면(로트 하나를 여러 품목 줄로 나눠
    // 적는 경우가 흔함) 대표 한 줄만 조회 대상으로 삼는다 — 나머지도 전부 PENDING
    // 으로 걸면 조회 자체는 캐시로 금방 끝나도 청크당 처리 건수(20건)만 갉아먹어
    // 정작 새로운 번호 처리가 뒤로 밀린다.
    const seenPrelookupTraceNos = new Set<string>();

    const lineRows = lines.map((line, index) => {
      const eligible = isEligibleForPrelookup(line.traceNo);
      const normalizedTraceNo = (line.traceNo ?? "").trim().toUpperCase();
      const isFirstOccurrence = eligible && !seenPrelookupTraceNos.has(normalizedTraceNo);

      if (eligible) {
        seenPrelookupTraceNos.add(normalizedTraceNo);
      }

      return {
        document_id: documentId,
        line_no: line.lineNo ?? index + 1,
        raw_text: line.raw ?? null,
        item_name: line.itemName?.trim() || null,
        product_id: line.productId || null,
        trace_no: line.traceNo?.trim() || null,
        part_name: line.partName?.trim() || null,
        grade: line.grade?.trim() || null,
        origin: line.origin?.trim() || null,
        quantity: line.quantity ?? null,
        labeled_weight: line.labeledWeight ?? null,
        unit_price: line.unitPrice ?? null,
        amount: line.amount ?? null,
        // 실물 도착 전 사전조회 대상이면 대기 상태로 걸어둔다 — 실제 조회는
        // processDocumentPrelookupChunkAction이 화면 반복 호출로 나눠서 처리한다.
        prelookup_status: isFirstOccurrence ? "PENDING" : null,
      };
    });

    if (lineRows.length > 0) {
      const { error: linesError } = await supabase
        .from("inbound_document_lines")
        .insert(lineRows);

      if (linesError) {
        // 품목을 읽어놓고 저장에 실패한 경우다. 껍데기 문서만 남기지 않고 되돌린다.
        await supabase.from("inbound_documents").delete().eq("id", documentId);
        throw linesError;
      }
    }

    // 사람이 확정한 칸 위치를 공급처별로 학습해둔다.
    if (input.columnMap && Object.keys(input.columnMap).length > 0) {
      await supabase.from("supplier_document_formats").upsert(
        {
          wholesaler_id: wholesalerId,
          supplier_key: supplierKeyOf(supplierName),
          supplier_name: supplierName,
          column_map: input.columnMap,
          sample_header: input.sampleHeader ?? null,
        },
        { onConflict: "wholesaler_id,supplier_key" }
      );
    }

    // 실물이 오기 전에 이력/로트번호를 미리 조회해둔다(사장님 지침 2026-09-24).
    // 여기서 직접 조회하지 않는다 — 줄이 많으면(로트+이력번호 다수) 정부 API 호출이
    // 크게 불어나 서버 액션 실행시간 제한을 넘길 위험이 있다. 화면이
    // processDocumentPrelookupChunkAction을 finished될 때까지 반복 호출해서 나눠 처리한다.
    const pendingPrelookupCount = lineRows.filter((line) => line.prelookup_status === "PENDING").length;

    revalidatePath(REVALIDATE_PATH);

    return {
      success: true,
      data: { documentId, lineCount: lineRows.length, fileStored, pendingPrelookupCount },
    };
  } catch (error) {
    return toResult(error);
  }
}

export interface ExtractedTable {
  cells: string[][];
  /** 글자가 하나라도 있었나. false면 스캔본·사진 PDF라 읽을 수 없다. */
  hasText: boolean;
  pageCount: number;
}

/**
 * PDF에서 표를 복원해 돌려준다.
 *
 * 브라우저에 PDF 파서를 싣지 않으려고 서버에서만 돌린다 — 현장 화면을 무겁게
 * 만들지 않는다. 파일이 한 번 더 올라가지만 명세서 PDF는 보통 작아서 괜찮다.
 */
export async function extractDocumentTableAction(
  formData: FormData
): Promise<ActionResult<ExtractedTable>> {
  try {
    await resolveDocumentScope();

    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      throw new RbacError("파일이 없습니다.");
    }

    if (file.size > MAX_FILE_BYTES) {
      throw new RbacError("파일이 너무 큽니다. 8MB 이하로 올려주세요.");
    }

    const { extractPdfTable } = await import("@/lib/livestock/pdf-extract");
    const table = await extractPdfTable(new Uint8Array(await file.arrayBuffer()));

    return {
      success: true,
      data: { cells: table.cells, hasText: table.hasText, pageCount: table.pageCount },
    };
  } catch (error) {
    return toResult(error);
  }
}

export interface LearnedFormat {
  supplierName: string;
  columnMap: Record<string, number>;
}

/** 같은 공급처 서류를 전에 읽어봤으면 그때 짚어준 칸 위치를 돌려준다. */
export async function loadSupplierFormatAction(
  supplierName: string
): Promise<ActionResult<LearnedFormat | null>> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();
    const key = supplierKeyOf(supplierName ?? "");

    if (!key) {
      return { success: true, data: null };
    }

    const { data } = await supabase
      .from("supplier_document_formats")
      .select("supplier_name, column_map")
      .eq("wholesaler_id", wholesalerId)
      .eq("supplier_key", key)
      .maybeSingle();

    if (!data) {
      return { success: true, data: null };
    }

    return {
      success: true,
      data: {
        supplierName: String(data.supplier_name),
        columnMap: (data.column_map ?? {}) as Record<string, number>,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 잘못 올린 서류를 목록에서 치운다 — **지우지 않고 감춘다.**
 *
 * 공급처 명세서는 매입 증빙이고, 축산물이력법상 매입에 관한 기록은 매입한 날부터
 * 1년간 보관해야 한다(매출은 2년). 그래서 기본 동작은 삭제가 아니라 취소 처리다.
 * 기록이 있는 상품을 삭제 대신 '보관'으로 감추게 한 12단계와 같은 판단이다.
 */
export async function discardInboundDocumentAction(
  documentId: string
): Promise<ActionResult> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();

    const { error } = await supabase
      .from("inbound_documents")
      .update({ status: "DISCARDED" })
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId);

    if (error) throw error;

    // 아직 조회 대기 중이던 줄은 대상에서 뺀다 — 안 그러면 취소한 서류인데도
    // findUnfinishedDocumentPrelookupAction/청크 처리가 계속 붙잡는다.
    await supabase
      .from("inbound_document_lines")
      .update({ prelookup_status: "FAILED", prelookup_error: DISCARD_SKIPPED_PRELOOKUP_ERROR })
      .eq("document_id", documentId)
      .eq("prelookup_status", "PENDING");

    revalidatePath(REVALIDATE_PATH);

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

/** 취소 처리된 서류를 되살린다. */
export async function restoreInboundDocumentAction(
  documentId: string
): Promise<ActionResult> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();

    const { data: existing } = await supabase
      .from("inbound_documents")
      .select("id, inbound_document_lines(count)")
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId)
      .maybeSingle();

    if (!existing) {
      throw new RbacError("해당 명세서를 찾을 수 없습니다.");
    }

    const counts = existing.inbound_document_lines as Array<{ count: number }> | null;

    const { error } = await supabase
      .from("inbound_documents")
      .update({ status: (counts?.[0]?.count ?? 0) > 0 ? "PENDING" : "DRAFT" })
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId);

    if (error) throw error;

    // 취소 때 건너뛴 조회 대상을 다시 대기 상태로 되돌린다.
    await supabase
      .from("inbound_document_lines")
      .update({ prelookup_status: "PENDING", prelookup_error: null })
      .eq("document_id", documentId)
      .eq("prelookup_status", "FAILED")
      .eq("prelookup_error", DISCARD_SKIPPED_PRELOOKUP_ERROR);

    revalidatePath(REVALIDATE_PATH);

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 원본까지 완전히 지운다 — 되돌릴 수 없다.
 *
 * 남의 서류나 엉뚱한 사진을 올린 경우처럼 애초에 우리 기록이면 안 되는 것만
 * 해당한다. 그래서 **취소 처리된 서류만** 지울 수 있게 두 단계로 나눴다.
 * 보관기간(매입 1년) 안의 진짜 매입 증빙을 실수로 날리지 않게 하려는 것이다.
 */
export async function deleteInboundDocumentAction(
  documentId: string
): Promise<ActionResult> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();

    const { data: existing } = await supabase
      .from("inbound_documents")
      .select("id, status, storage_path")
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId)
      .maybeSingle();

    if (!existing) {
      throw new RbacError("해당 명세서를 찾을 수 없습니다.");
    }

    if (String(existing.status) !== "DISCARDED") {
      throw new RbacError("먼저 '취소 처리'를 한 뒤에 완전히 지울 수 있습니다.");
    }

    if (existing.storage_path) {
      await supabase.storage
        .from("inbound-documents")
        .remove([String(existing.storage_path)]);
    }

    // 줄은 ON DELETE CASCADE로 함께 지워진다.
    const { error } = await supabase
      .from("inbound_documents")
      .delete()
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId);

    if (error) throw error;

    revalidatePath(REVALIDATE_PATH);

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

/** 보관된 원본을 잠깐 열어보는 링크. 비공개 버킷이라 서명이 필요하다. */
export async function getDocumentFileUrlAction(
  documentId: string
): Promise<ActionResult<string>> {
  try {
    const { supabase, wholesalerId } = await resolveDocumentScope();

    const { data } = await supabase
      .from("inbound_documents")
      .select("storage_path")
      .eq("id", documentId)
      .eq("wholesaler_id", wholesalerId)
      .maybeSingle();

    if (!data?.storage_path) {
      throw new RbacError("보관된 원본 파일이 없습니다.");
    }

    const { data: signed, error } = await supabase.storage
      .from("inbound-documents")
      .createSignedUrl(String(data.storage_path), 60 * 5);

    if (error || !signed) {
      throw error ?? new Error("링크 생성 실패");
    }

    return { success: true, data: signed.signedUrl };
  } catch (error) {
    return toResult(error);
  }
}
