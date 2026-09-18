"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import { sendCreditLimitIncreasedNotificationToRetailer } from "@/lib/notifications/alimtalk";
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

    // 알림톡 발송 여부 판단(한도가 실제로 바뀌었는지)을 위해 갱신 전 값을 먼저 읽는다.
    const { data: before } = await supabase
      .from("wholesaler_retailers")
      .select("credit_limit")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("retailer_id", retailerId)
      .maybeSingle();

    const previousLimit = before ? Number(before.credit_limit ?? 0) : null;

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

    // 한도를 "올려준" 경우에만 거래처에 알림톡 발송 — 하향은 알림 대상이 아니다
    // (사용자 결정: 상향만 "주문 가능" 소식으로 통지, 정확한 금액은 넣지 않는다).
    // 미설정/발송 실패는 저장 자체를 막지 않는다(알림톡은 부가 기능).
    if (previousLimit !== null && creditLimit > previousLimit) {
      const { data: retailer } = await supabase
        .from("retailers")
        .select("restaurant_name, profile_id")
        .eq("id", retailerId)
        .maybeSingle();

      if (retailer) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("phone")
          .eq("id", retailer.profile_id as string)
          .maybeSingle();

        await sendCreditLimitIncreasedNotificationToRetailer({
          wholesalerId: scope.wholesalerId,
          wholesalerName: scope.businessName,
          retailerName: (retailer.restaurant_name as string) ?? "거래처",
          retailerPhone: (profile?.phone as string | undefined) ?? undefined,
        });
      }
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "여신 한도 저장 중 오류가 발생했습니다.",
    };
  }
}

const RETAILER_STATUS_ERROR_MESSAGES: Record<string, string> = {
  NOT_A_WHOLESALER: "공급사 계정에서만 사용할 수 있습니다.",
  INVALID_STATUS: "잘못된 상태 값입니다.",
  BLOCK_REASON_REQUIRED: "거래중지 사유를 입력해주세요.",
  RETAILER_NOT_FOUND: "해당 거래처를 찾을 수 없습니다.",
  STATUS_UNCHANGED: "이미 해당 상태입니다.",
  REACTIVATION_COOLDOWN: "거래중지 후 7일이 지나야 거래를 재개할 수 있습니다.",
};

/**
 * 거래처 거래중지/재개. 정지 남용(과금 회피용 토글) 방지를 위해 실제 검증(사유 필수,
 * 재개 냉각기간)은 DB 함수(set_wholesaler_retailer_status)에서 수행한다 — 자세한
 * 내용은 해당 마이그레이션 주석 참고. 돈과 직결되는 조작이라 여신 한도와 동일하게
 * owner/manager만 허용.
 */
export async function updateRetailerStatusAction(
  retailerId: string,
  status: "active" | "blocked",
  reason?: string
): Promise<ActionResult> {
  try {
    try {
      await requireOrgRole(["owner", "manager"]);
    } catch (err) {
      return { success: false, error: err instanceof RbacError ? err.message : "권한이 없습니다." };
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc("set_wholesaler_retailer_status", {
      p_retailer_id: retailerId,
      p_status: status,
      p_reason: reason ?? null,
    });

    if (error) {
      return {
        success: false,
        error: RETAILER_STATUS_ERROR_MESSAGES[error.message] ?? "상태 변경에 실패했습니다.",
      };
    }

    revalidatePath("/dashboard/customers");

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "상태 변경 중 오류가 발생했습니다.",
    };
  }
}
