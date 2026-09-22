"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import {
  fetchTraceRecord,
  isMtraceConfigured,
  isPlausibleTraceNo,
  MtraceError,
} from "@/lib/livestock/mtrace-client";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/inbound";

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
  /** 이력 정보로 상품을 새로 만든 경우 — 화면에서 "가격을 넣어달라"고 안내한다. */
  autoCreated: { productName: string; needsPrice: boolean } | null;
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

  if (!wholesalerId) {
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

  return { supabase, context, wholesalerId };
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
}): Promise<ActionResult<ScanResult | { duplicate: DuplicateWarning }>> {
  try {
    const { supabase } = await resolveInboundScope();

    const traceNo = input.traceNo.trim().toUpperCase();

    if (!isPlausibleTraceNo(traceNo)) {
      throw new RbacError("이력번호 형식이 올바르지 않습니다. 다시 스캔해주세요.");
    }

    if (!Number.isFinite(input.weight) || input.weight <= 0) {
      throw new RbacError("중량을 입력해주세요.");
    }

    // 1) 마스터 캐시 확인
    const { data: cached } = await supabase
      .from("master_livestock")
      .select("trace_no")
      .eq("trace_no", traceNo)
      .maybeSingle();

    let failReason: string | null = null;

    // 2) 캐시에 없으면 공공 API 호출 → 마스터 적재
    if (!cached) {
      if (!isMtraceConfigured()) {
        // 인증키 미발급 상태. 물건은 실제로 들어왔으므로 막지 않고 예외로 남긴다.
        failReason = "API_ERROR";
      } else {
        try {
          const record = await fetchTraceRecord(traceNo);

          if (record) {
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
              throw new Error(upsertError.message);
            }
          } else {
            failReason = "NOT_FOUND";
          }
        } catch (error) {
          // 조회 실패로 현장 입고를 막지 않는다 — 예외로 남기고 나중에 보정한다.
          failReason = error instanceof MtraceError ? "API_ERROR" : "API_ERROR";
        }
      }
    }

    // 3) 스캔 기록 (스캔 + 원장 + 재고 + 예외가 한 트랜잭션)
    const { data, error } = await supabase.rpc("record_inbound_scan", {
      p_trace_no: traceNo,
      p_weight: input.weight,
      p_scan_type: input.scanType,
      p_product_id: input.productId ?? null,
      p_fail_reason: failReason,
      p_import_row_id: null,
      p_memo: input.memo ?? null,
      p_confirm_duplicate: input.confirmDuplicate ?? false,
    });

    if (error) {
      const duplicate = error.message.match(/DUPLICATE_SUSPECTED:(\d{2}:\d{2})/);

      if (duplicate) {
        return { success: true, data: { duplicate: { lastScannedAt: duplicate[1] } } };
      }

      throw new Error(error.message);
    }

    const row = data as Record<string, unknown>;

    // 처음 취급하는 고기면 이력 정보(축종·부위·등급)로 상품을 자동 생성한다.
    // 공공 API가 이미 알려준 값을 사람이 다시 입력하게 할 이유가 없다.
    // 부위를 모르면 자동 생성이 건너뛰어지고 아래 목록에서 되묻는다.
    let autoCreated: { productName: string; needsPrice: boolean } | null = null;

    if (row.status === "PENDING_MAPPING") {
      const { data: created } = await supabase.rpc("autocreate_product_for_scan", {
        p_scan_id: String(row.scan_id),
      });

      const createdRow = created as Record<string, unknown> | null;

      if (createdRow?.product_id) {
        row.status = "NORMAL";
        row.product_id = createdRow.product_id;

        if (createdRow.created) {
          autoCreated = {
            productName: String(createdRow.product_name ?? ""),
            needsPrice: Boolean(createdRow.needs_price),
          };
        }
      }
    }

    revalidatePath(REVALIDATE_PATH);
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
        autoCreated,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/** 상품 미확정(PENDING_MAPPING)/예외 건에 상품을 지정해 재고로 확정한다. */
export async function resolveMappingAction(
  scanId: string,
  productId: string,
  remember = true
): Promise<ActionResult> {
  try {
    const { supabase } = await resolveInboundScope();

    const { error } = await supabase.rpc("resolve_inbound_mapping", {
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

    revalidatePath(REVALIDATE_PATH);
    revalidatePath("/dashboard/products");

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

/** 오스캔 취소 — 삭제가 아니라 역분개로 처리된다. */
export async function voidScanAction(scanId: string, reason?: string): Promise<ActionResult> {
  try {
    const { supabase } = await resolveInboundScope();

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

    revalidatePath(REVALIDATE_PATH);
    revalidatePath("/dashboard/products");

    return { success: true };
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
