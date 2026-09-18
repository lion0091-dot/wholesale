"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import type { ActionResult } from "@/app/actions/invite";

const VALID_PAYMENT_METHODS = ["prepaid", "on_credit", "pg"];

/**
 * 거래처(바이어)의 여신 한도 / 연체 기준일 / 허용 결제수단 수정. 돈과 직결되는
 * 조작이라 owner/manager만 허용한다(RLS도 20260930000019에서 동일 기준으로 맞춰둠).
 *
 * allowedPaymentMethods는 "공급사가 이 방식을 열어줬는가"만 나타낸다 — 외상은
 * creditLimit>0일 때만, PG는 wholesalers.pg_client_key가 설정돼 있을 때만 실제로
 * 체크아웃에 노출된다(전체 조건은 checkout-view.tsx에서 다시 검증).
 */
export async function updateCreditLimitAction(
  retailerId: string,
  creditLimit: number,
  settlementDueDays: number,
  allowedPaymentMethods: string[]
): Promise<ActionResult> {
  try {
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      return { success: false, error: "여신 한도는 0 이상의 숫자여야 합니다." };
    }

    if (!Number.isFinite(settlementDueDays) || settlementDueDays <= 0) {
      return { success: false, error: "연체 기준일은 1 이상의 숫자여야 합니다." };
    }

    const methods = allowedPaymentMethods.filter((method) => VALID_PAYMENT_METHODS.includes(method));

    if (methods.length === 0) {
      return { success: false, error: "허용할 결제수단을 하나 이상 선택해주세요." };
    }

    try {
      await requireOrgRole(["owner", "manager"]);
    } catch (err) {
      return { success: false, error: err instanceof RbacError ? err.message : "권한이 없습니다." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();

    const { data, error } = await supabase
      .from("wholesaler_retailers")
      .update({
        credit_limit: creditLimit,
        settlement_due_days: settlementDueDays,
        allowed_payment_methods: methods,
      })
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
    revalidatePath("/dashboard/receivables");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "여신 한도 저장 중 오류가 발생했습니다.",
    };
  }
}
