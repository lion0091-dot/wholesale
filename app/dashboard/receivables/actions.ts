"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { computeDueAt, isOverdue } from "@/lib/orders/receivables";
import { sendReceivablesReminderToRetailer } from "@/lib/notifications/alimtalk";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 선택한 외상 주문들을 정산완료 처리한다.
 * settle_credit_orders RPC가 소유권/외상 여부/미정산 여부를 다시 검증하고,
 * 거래처별 미수금 잔액도 원자적으로 함께 차감한다 (이미 정산됐거나 소유권이 없는
 * id는 조용히 제외되고, 결과 화면은 revalidatePath 이후 최신 상태로 다시 그려진다).
 */
export async function settleCreditOrdersAction(orderIds: string[]): Promise<ActionResult> {
  try {
    if (orderIds.length === 0) {
      return { success: false, error: "정산할 주문을 선택해주세요." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc("settle_credit_orders", {
      p_order_ids: orderIds,
    });

    if (error) {
      return { success: false, error: error.message ?? "정산 처리에 실패했습니다." };
    }

    revalidatePath("/dashboard/receivables");
    revalidatePath("/dashboard/customers");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "정산 처리 중 오류가 발생했습니다.",
    };
  }
}

interface RetailerJoin {
  restaurant_name: string;
  profile_id: string;
}

/**
 * 특정 거래처에 미수금 정산 기한 리마인드 알림톡을 수동 발송한다.
 * 클라이언트가 보낸 잔액/기한을 신뢰하지 않고 DB에서 다시 조회해서 사용한다.
 */
export async function sendReceivablesReminderAction(retailerId: string): Promise<ActionResult<string>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { data: relation } = await supabase
      .from("wholesaler_retailers")
      .select("outstanding_balance, settlement_due_days, retailers ( restaurant_name, profile_id )")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .maybeSingle();

    if (!relation) {
      return { success: false, error: "거래처 정보를 찾을 수 없습니다." };
    }

    const outstandingBalance = Number(relation.outstanding_balance ?? 0);

    if (outstandingBalance <= 0) {
      return { success: false, error: "미수금이 없는 거래처입니다." };
    }

    const retailer = (Array.isArray(relation.retailers) ? relation.retailers[0] : relation.retailers) as
      | RetailerJoin
      | null;

    if (!retailer) {
      return { success: false, error: "거래처 정보를 찾을 수 없습니다." };
    }

    const { data: nearestOrder } = await supabase
      .from("orders")
      .select("ordered_at")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .eq("payment_method", "on_credit")
      .is("settled_at", null)
      .order("ordered_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!nearestOrder) {
      return { success: false, error: "미정산 외상 주문이 없습니다." };
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("phone")
      .eq("id", retailer.profile_id)
      .maybeSingle();

    const nearestDueAt = computeDueAt(nearestOrder.ordered_at, relation.settlement_due_days);

    const result = await sendReceivablesReminderToRetailer({
      wholesalerName: scope.businessName,
      retailerName: retailer.restaurant_name,
      retailerPhone: (profile?.phone as string | undefined) ?? undefined,
      outstandingBalance,
      nearestDueAt,
      isOverdue: isOverdue(nearestDueAt),
    });

    return {
      success: result.success,
      error: result.success ? undefined : "알림톡 발송에 실패했습니다.",
      data: result.channel === "mock_log" ? "테스트 모드로 발송됐습니다." : "알림톡이 발송됐습니다.",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "리마인드 발송 중 오류가 발생했습니다.",
    };
  }
}
