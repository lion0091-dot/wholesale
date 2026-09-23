"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/outbound";

/** 출고도 현장 작업이라 staff까지 허용한다. */
const OUTBOUND_ROLES: OrgRole[] = ["owner", "manager", "staff"];

export interface OutboundProgressRow {
  productId: string;
  productName: string;
  unit: string;
  orderedQty: number;
  scannedQty: number;
  traceNos: string | null;
}

export interface OutboundScanResult {
  traceNo: string;
  productName: string;
  taken: number;
  ordered: number;
  assigned: number;
  remainingNeeded: number;
  /**
   * 박스의 이력 부위와 상품 부위가 다를 때 true. 막지는 않는다 —
   * 표기 차이로 헛경고가 날 수 있고 실제로는 맞는데 막으면 현장이 멈춘다.
   */
  partMismatch: boolean;
  tracePart: string | null;
  productPart: string | null;
  /** 바코드에 유통기한이 실려 있던 박스만 값이 있다. */
  bestBefore: string | null;
  daysLeft: number | null;
}

export interface PickingRow {
  productId: string;
  productName: string;
  unit: string;
  boxId: string;
  traceNo: string;
  /** 이 박스에서 가져갈 양. 박스 전체가 아니라 주문에 필요한 만큼이다. */
  suggestedQty: number;
  boxWeight: number;
  grade: string | null;
  slaughterDate: string | null;
  /** 이미 출고 스캔을 마친 박스. 목록에서 빼지 않고 표시만 한다. */
  alreadyPicked: boolean;
  bestBefore: string | null;
  daysLeft: number | null;
}

/** DB가 던지는 코드를 현장에서 읽을 문장으로 바꾼다. */
const SCAN_ERRORS: Record<string, string> = {
  BOX_NOT_AVAILABLE: "재고에 없는 이력번호입니다. 입고된 박스인지, 이미 다 나간 박스는 아닌지 확인해주세요.",
  PRODUCT_NOT_IN_ORDER: "이 주문에 없는 상품입니다. 박스를 다시 확인해주세요.",
  PRODUCT_ALREADY_FULFILLED: "이 상품은 주문 수량을 이미 다 채웠습니다.",
  ORDER_NOT_FOUND: "발주서를 찾을 수 없습니다.",
  EMPTY_TRACE_NO: "이력번호를 읽지 못했습니다.",
  INVALID_WEIGHT: "가져올 수 있는 중량이 없습니다.",
  ALREADY_FINALIZED: "이미 마감(금액 확정)된 발주서입니다. 추가로 나가는 물건은 별도로 처리해주세요.",
};

async function resolveOutboundScope() {
  const context = await requireOrgRole(OUTBOUND_ROLES);
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
    throw new RbacError("공급사 업체 정보가 없어 출고를 처리할 수 없습니다.");
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
 * 출고 스캔 1건.
 *
 * 주문 확정 시 선입선출로 잡아둔 자동 배정을, 작업자가 실제로 집은 박스로
 * 정정한다. 첫 스캔에서 자동 배정을 되돌리는 건 DB가 처리한다.
 */
export async function recordOutboundScanAction(
  orderId: string,
  traceNo: string,
  weight?: number | null
): Promise<ActionResult<OutboundScanResult>> {
  try {
    const { supabase } = await resolveOutboundScope();

    const { data, error } = await supabase.rpc("record_outbound_scan", {
      p_order_id: orderId,
      p_trace_no: traceNo,
      p_weight: weight ?? null,
    });

    if (error) {
      const matched = Object.keys(SCAN_ERRORS).find((code) => error.message.includes(code));

      if (matched) {
        throw new RbacError(SCAN_ERRORS[matched]);
      }

      // 기한 경과는 확인 버튼으로 넘길 수 없다 — 날짜를 짚어 알려주고 끝낸다.
      const expired = error.message.match(/BOX_EXPIRED:(\d{4}-\d{2}-\d{2})/);

      if (expired) {
        throw new RbacError(
          `유통기한이 지난 박스입니다 (${expired[1]}). 출고할 수 없습니다 — 폐기 또는 반품 처리해주세요.`
        );
      }

      if (error.message.includes("ORDER_NOT_SHIPPABLE")) {
        throw new RbacError("확정 또는 배송중 상태의 발주서만 출고할 수 있습니다.");
      }

      throw new Error(error.message);
    }

    const row = (data ?? {}) as Record<string, unknown>;

    revalidatePath(REVALIDATE_PATH);
    revalidatePath("/dashboard/products");

    return {
      success: true,
      data: {
        traceNo: String(row.trace_no ?? ""),
        productName: String(row.product_name ?? ""),
        taken: Number(row.taken ?? 0),
        ordered: Number(row.ordered ?? 0),
        assigned: Number(row.assigned ?? 0),
        remainingNeeded: Number(row.remaining_needed ?? 0),
        partMismatch: Boolean(row.part_mismatch),
        tracePart: (row.trace_part as string | null) ?? null,
        productPart: (row.product_part as string | null) ?? null,
        bestBefore: (row.best_before as string | null) ?? null,
        daysLeft:
          row.days_left === null || row.days_left === undefined ? null : Number(row.days_left),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/** 주문별 출고 진행 상황 — 스캔 후 화면을 갱신할 때 쓴다. */
export async function getOutboundProgressAction(
  orderId: string
): Promise<ActionResult<OutboundProgressRow[]>> {
  try {
    const { supabase } = await resolveOutboundScope();

    const { data, error } = await supabase.rpc("get_outbound_progress", { p_order_id: orderId });

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      data: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        productId: String(row.product_id),
        productName: String(row.product_name ?? ""),
        unit: String(row.unit ?? "kg"),
        orderedQty: Number(row.ordered_qty ?? 0),
        scannedQty: Number(row.scanned_qty ?? 0),
        traceNos: (row.trace_nos as string | null) ?? null,
      })),
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 피킹 목록 — 창고에서 어느 박스를 가져와야 하는지.
 *
 * 스캔 전에는 확정 때 선입선출로 잡아둔 배정이 그대로 추천이고, 스캔이
 * 시작되면 남은 필요량을 현재 가용 박스에서 다시 계산한다. 이미 찍은 박스도
 * 목록에 남겨 표시한다(사라지면 작업자가 기억해야 한다).
 */
export async function getPickingListAction(
  orderId: string
): Promise<ActionResult<PickingRow[]>> {
  try {
    const { supabase } = await resolveOutboundScope();

    const { data, error } = await supabase.rpc("get_picking_list", { p_order_id: orderId });

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      data: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        productId: String(row.product_id),
        productName: String(row.product_name ?? ""),
        unit: String(row.unit ?? "kg"),
        boxId: String(row.box_id),
        traceNo: String(row.trace_no ?? ""),
        suggestedQty: Number(row.suggested_qty ?? 0),
        boxWeight: Number(row.box_weight ?? 0),
        grade: (row.grade as string | null) ?? null,
        slaughterDate: (row.slaughter_date as string | null) ?? null,
        alreadyPicked: Boolean(row.already_picked),
        bestBefore: (row.best_before as string | null) ?? null,
        daysLeft:
          row.days_left === null || row.days_left === undefined ? null : Number(row.days_left),
      })),
    };
  } catch (error) {
    return toResult(error);
  }
}

export interface ShipmentPreviewRow {
  productId: string;
  productName: string;
  unit: string;
  unitPrice: number;
  orderedQty: number;
  shippedQty: number;
  /** 음수면 주문보다 덜 나갔다. */
  diffQty: number;
  orderedAmount: number;
  shippedAmount: number;
}

export interface FinalizeResult {
  wasShort: boolean;
  prevAmount: number;
  totalAmount: number;
}

/** 마감 전 미리보기 — 주문 대비 실제 출고량과 금액 변화. 아무것도 바꾸지 않는다. */
export async function previewShipmentAction(
  orderId: string
): Promise<ActionResult<ShipmentPreviewRow[]>> {
  try {
    const { supabase } = await resolveOutboundScope();

    const { data, error } = await supabase.rpc("preview_order_shipment", {
      p_order_id: orderId,
    });

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      data: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        productId: String(row.product_id),
        productName: String(row.product_name ?? ""),
        unit: String(row.unit ?? "kg"),
        unitPrice: Number(row.unit_price ?? 0),
        orderedQty: Number(row.ordered_qty ?? 0),
        shippedQty: Number(row.shipped_qty ?? 0),
        diffQty: Number(row.diff_qty ?? 0),
        orderedAmount: Number(row.ordered_amount ?? 0),
        shippedAmount: Number(row.shipped_amount ?? 0),
      })),
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 출고 마감 — 실제 중량으로 금액을 확정하고 배송 상태로 넘긴다.
 *
 * 주문보다 덜 나갔으면 confirmShort 없이는 DB가 SHIPMENT_SHORT 를 던진다.
 * 화면이 차이를 보여주고 사람이 누른 뒤에 다시 부른다.
 */
export async function finalizeShipmentAction(
  orderId: string,
  confirmShort = false
): Promise<ActionResult<FinalizeResult>> {
  try {
    const { supabase } = await resolveOutboundScope();

    const { data, error } = await supabase.rpc("finalize_order_shipment", {
      p_order_id: orderId,
      p_confirm_short: confirmShort,
    });

    if (error) {
      if (error.message.includes("SHIPMENT_SHORT")) {
        throw new RbacError("SHIPMENT_SHORT");
      }

      if (error.message.includes("ALREADY_FINALIZED")) {
        throw new RbacError("이미 마감된 발주서입니다.");
      }

      if (error.message.includes("ORDER_NOT_SHIPPABLE")) {
        throw new RbacError("확정 상태의 발주서만 마감할 수 있습니다.");
      }

      if (error.message.includes("ORDER_NOT_FOUND")) {
        throw new RbacError("발주서를 찾을 수 없습니다.");
      }

      throw new Error(error.message);
    }

    const row = (data ?? {}) as Record<string, unknown>;

    revalidatePath(REVALIDATE_PATH);
    revalidatePath("/dashboard/orders");

    return {
      success: true,
      data: {
        wasShort: Boolean(row.was_short),
        prevAmount: Number(row.prev_amount ?? 0),
        totalAmount: Number(row.total_amount ?? 0),
      },
    };
  } catch (error) {
    return toResult(error);
  }
}
