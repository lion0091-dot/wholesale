"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { ORDER_STATUS_TRANSITIONS, isSupplierAssignableStatus } from "@/lib/orders/status";
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
