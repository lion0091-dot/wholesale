"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 거래처(바이어)의 여신 한도 수정.
 * RLS(wholesaler_id = get_current_wholesaler_id())가 소유권을 한 번 더 검증하므로,
 * 여기서의 wholesaler_id 필터는 방어선 중 하나일 뿐이다.
 */
export async function updateCreditLimitAction(
  retailerId: string,
  creditLimit: number
): Promise<ActionResult> {
  try {
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      return { success: false, error: "여신 한도는 0 이상의 숫자여야 합니다." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { data, error } = await supabase
      .from("wholesaler_retailers")
      .update({ credit_limit: creditLimit })
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .select("id")
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message ?? "여신 한도 저장에 실패했습니다." };
    }

    if (!data) {
      return { success: false, error: "해당 거래처를 찾을 수 없습니다." };
    }

    revalidatePath("/dashboard/customers");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "여신 한도 저장 중 오류가 발생했습니다.",
    };
  }
}
