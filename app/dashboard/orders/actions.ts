"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { ORDER_STATUS_TRANSITIONS, isSupplierAssignableStatus } from "@/lib/orders/status";
import {
  KOREAN_COURIERS,
  fetchTrackingStatus,
  type TrackingResult,
} from "@/lib/verification/sweettracker";
import type { OrderStatus } from "@/types/database";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const REVALIDATE_PATH = "/dashboard/orders";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 발주 처리는 staff까지 허용한다 (PRD: 직원은 발주 접수/출고 처리 담당) */
const ORDER_ROLES: OrgRole[] = ["owner", "manager", "staff"];

const VALID_STATUSES: OrderStatus[] = [
  "pending",
  "confirmed",
  "shipping",
  "delivered",
  "cancel_requested",
  "cancel_rejected",
  "cancelled",
];

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/** 주문도 상품과 동일하게 레거시 wholesalers.id로 스코프된다. */
async function resolveOrderScope() {
  const context = await requireOrgRole(ORDER_ROLES);
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
    throw new RbacError("공급사 업체 정보가 없어 발주를 처리할 수 없습니다.");
  }

  return { supabase, context, wholesalerId };
}

/**
 * 주문 상태 변경.
 * 소유 공급사 검증 + 상태 전이 규칙(ORDER_STATUS_TRANSITIONS) 검증을 함께 수행한다.
 */
export async function updateOrderStatusAction(
  orderId: string,
  nextStatus: OrderStatus
): Promise<ActionResult<{ status: OrderStatus }>> {
  try {
    const { supabase, context, wholesalerId } = await resolveOrderScope();

    if (!UUID_PATTERN.test(orderId)) {
      throw new RbacError("올바른 주문 식별자가 아닙니다.");
    }

    if (!VALID_STATUSES.includes(nextStatus)) {
      throw new RbacError("변경할 수 없는 주문 상태입니다.");
    }

    // 취소 '요청'은 바이어만 생성할 수 있고, 공급사는 승인/반려만 한다.
    if (!isSupplierAssignableStatus(nextStatus)) {
      throw new RbacError("취소 요청은 바이어만 생성할 수 있습니다.");
    }

    const { data: order } = await supabase
      .from("orders")
      .select("id, wholesaler_id, status")
      .eq("id", orderId)
      .maybeSingle();

    if (!order) {
      throw new RbacError("해당 발주서를 찾을 수 없습니다.");
    }

    if (!context.isSuperAdmin && order.wholesaler_id !== wholesalerId) {
      throw new RbacError("다른 공급사의 발주서는 처리할 수 없습니다.");
    }

    const currentStatus = order.status as OrderStatus;

    if (currentStatus === nextStatus) {
      return { success: true, data: { status: nextStatus } };
    }

    if (!ORDER_STATUS_TRANSITIONS[currentStatus].includes(nextStatus)) {
      throw new RbacError("현재 상태에서는 해당 처리를 진행할 수 없습니다.");
    }

    const { error } = await supabase
      .from("orders")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", orderId);

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    revalidatePath(`${REVALIDATE_PATH}/${orderId}`);

    return { success: true, data: { status: nextStatus } };
  } catch (error) {
    return toResult(error);
  }
}

/** 주문 소유권만 확인하고 반환한다 — 상태 전이 검증이 필요 없는 부가 필드용. */
async function loadOwnedOrder(orderId: string, wholesalerId: string, isSuperAdmin: boolean) {
  const supabase = await createClient();

  if (!UUID_PATTERN.test(orderId)) {
    throw new RbacError("올바른 주문 식별자가 아닙니다.");
  }

  const { data: order } = await supabase
    .from("orders")
    .select("id, wholesaler_id, courier_code, tracking_number, status")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) {
    throw new RbacError("해당 발주서를 찾을 수 없습니다.");
  }

  if (!isSuperAdmin && order.wholesaler_id !== wholesalerId) {
    throw new RbacError("다른 공급사의 발주서는 처리할 수 없습니다.");
  }

  return { supabase, order };
}

/**
 * 배송 조회 정보(택배사/운송장번호) 저장 — 정산은 관여하지 않는 순수 조회용 메타데이터다.
 *
 * 운송장번호를 입력한다는 건 실질적으로 이미 상차/출고했다는 뜻이라, 현재 상태가
 * `confirmed`(확정)일 때는 저장과 동시에 `shipping`으로 자동 전환한다. ORDER_STATUS_TRANSITIONS
 * 가드를 그대로 재사용해서 confirmed가 아닌 상태(예: pending, 이미 shipping/delivered)에서는
 * 건드리지 않는다 — "출고/배송 시작" 수동 버튼(updateOrderStatusAction)은 그대로 남겨둔다.
 */
export async function updateOrderTrackingAction(
  orderId: string,
  courierCode: string,
  trackingNumber: string
): Promise<ActionResult<{ courierCode: string; trackingNumber: string; status: OrderStatus }>> {
  try {
    const { context, wholesalerId } = await resolveOrderScope();

    if (!KOREAN_COURIERS.some((courier) => courier.code === courierCode)) {
      throw new RbacError("지원하지 않는 택배사입니다.");
    }

    const trimmedNumber = trackingNumber.trim();

    if (!trimmedNumber) {
      throw new RbacError("운송장번호를 입력해주세요.");
    }

    const { supabase, order } = await loadOwnedOrder(orderId, wholesalerId, context.isSuperAdmin);

    const currentStatus = order.status as OrderStatus;
    const shouldAutoShip =
      currentStatus === "confirmed" && ORDER_STATUS_TRANSITIONS.confirmed.includes("shipping");
    const nextStatus: OrderStatus = shouldAutoShip ? "shipping" : currentStatus;

    const { error } = await supabase
      .from("orders")
      .update({
        courier_code: courierCode,
        tracking_number: trimmedNumber,
        ...(shouldAutoShip ? { status: "shipping", updated_at: new Date().toISOString() } : {}),
      })
      .eq("id", orderId);

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    revalidatePath(`${REVALIDATE_PATH}/${orderId}`);

    return { success: true, data: { courierCode, trackingNumber: trimmedNumber, status: nextStatus } };
  } catch (error) {
    return toResult(error);
  }
}

/** 저장된 택배사/운송장번호로 스위트트래커 배송 상태를 라이브 조회한다. */
export async function fetchOrderTrackingStatusAction(
  orderId: string
): Promise<ActionResult<TrackingResult>> {
  try {
    const { context, wholesalerId } = await resolveOrderScope();
    const { order } = await loadOwnedOrder(orderId, wholesalerId, context.isSuperAdmin);

    if (!order.courier_code || !order.tracking_number) {
      throw new RbacError("아직 등록된 운송장번호가 없습니다.");
    }

    const result = await fetchTrackingStatus(order.courier_code, order.tracking_number);

    return { success: true, data: result };
  } catch (error) {
    return toResult(error);
  }
}
