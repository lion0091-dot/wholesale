"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole } from "@/lib/auth/rbac";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 전표 줄 "무게 기준" 판정의 허용 오차(%) 업체별 설정(마이그레이션 127).
 * 최소 주문 금액과 같은 기준으로 owner/manager만 바꾼다. 기본 2%, 0.5~20% 사이.
 */

export interface WeightToleranceSettings {
  percent: number;
}

export async function getWeightToleranceSettingsAction(): Promise<ActionResult<WeightToleranceSettings>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("get_weight_tolerance", { p_wholesaler_id: scope.wholesalerId });

    if (error || data === null || data === undefined) {
      return { success: false, error: error?.message ?? "설정을 읽지 못했습니다." };
    }

    return { success: true, data: { percent: Math.round(Number(data) * 1000) / 10 } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "설정 조회 중 오류가 발생했습니다." };
  }
}

export async function saveWeightToleranceAction(percent: number): Promise<ActionResult> {
  try {
    await requireOrgRole(["owner", "manager"]);

    if (!Number.isFinite(percent) || percent < 0.5 || percent > 20) {
      return { success: false, error: "허용 오차는 0.5% 이상 20% 이하로 입력해주세요." };
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc("set_weight_tolerance_percent", {
      p_wholesaler_id: scope.wholesalerId,
      p_percent: percent,
    });

    if (error) {
      return {
        success: false,
        error: error.message.includes("FORBIDDEN") ? "사장·매니저만 바꿀 수 있습니다." : error.message,
      };
    }

    revalidatePath("/dashboard", "layout");

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "저장 중 오류가 발생했습니다." };
  }
}
