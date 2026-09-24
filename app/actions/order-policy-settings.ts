"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import type { ActionResult } from "@/app/actions/invite";
import { DEFAULT_MIN_ORDER_AMOUNT } from "@/lib/shop/order-policy";

/**
 * 최소 주문 금액(배송 1건 기준) 공급사별 설정.
 *
 * 알림톡·PG·네고와 동일하게 owner/manager만 바꿀 수 있다 — 매출 정책에 해당하는
 * 결정이라 일반 staff에게는 열지 않는다. 기본값은 50,000원(마이그레이션
 * 20260930000095) — 플랫폼 전체 하드코딩이던 기존 값과 동일해 마이그레이션
 * 적용만으로는 화면이 안 바뀐다.
 */

export interface OrderPolicySettings {
  minOrderAmount: number;
}

export async function getOrderPolicySettingsAction(): Promise<ActionResult<OrderPolicySettings>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("wholesalers")
      .select("min_order_amount")
      .eq("id", scope.wholesalerId)
      .maybeSingle();

    if (error) {
      return { success: false, error: error.message };
    }

    if (!data) {
      return { success: false, error: "업체 정보를 찾을 수 없습니다." };
    }

    return {
      success: true,
      data: { minOrderAmount: Number(data.min_order_amount ?? DEFAULT_MIN_ORDER_AMOUNT) },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "설정 조회 중 오류가 발생했습니다.",
    };
  }
}

export async function saveMinOrderAmountAction(minOrderAmount: number): Promise<ActionResult> {
  try {
    await requireOrgRole(["owner", "manager"]);

    if (!Number.isFinite(minOrderAmount) || minOrderAmount < 0) {
      return { success: false, error: "최소 주문 금액은 0 이상의 숫자여야 합니다." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();
    const { error } = await supabase
      .from("wholesalers")
      .update({ min_order_amount: minOrderAmount })
      .eq("id", scope.wholesalerId);

    if (error) {
      return { success: false, error: error.message };
    }

    revalidatePath("/dashboard/invites");

    return { success: true };
  } catch (error) {
    if (error instanceof RbacError) {
      return { success: false, error: error.message };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "저장 중 오류가 발생했습니다.",
    };
  }
}
