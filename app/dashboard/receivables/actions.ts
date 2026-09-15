"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
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
