"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { requireOrgRole, RbacError } from "@/lib/auth/rbac";
import type { ActionResult } from "@/app/actions/invite";

/**
 * 미니샵 장바구니 네고(희망가 제안) 켜고 끄기.
 *
 * 알림톡·PG와 동일하게 owner/manager만 켜고 끌 수 있다 — 흥정을 받을지 말지는
 * 매출/가격 정책에 해당하는 결정이라 일반 staff에게는 열지 않는다. 기본값은
 * 꺼짐(`wholesalers.allow_price_negotiation`, 마이그레이션 20260930000080).
 */

export interface NegotiationSettingsStatus {
  enabled: boolean;
}

export async function getNegotiationSettingsAction(): Promise<
  ActionResult<NegotiationSettingsStatus>
> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("wholesalers")
      .select("allow_price_negotiation")
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
      data: { enabled: Boolean(data.allow_price_negotiation) },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "설정 조회 중 오류가 발생했습니다.",
    };
  }
}

export async function saveNegotiationSettingsAction(enabled: boolean): Promise<ActionResult> {
  try {
    await requireOrgRole(["owner", "manager"]);

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다. 다시 로그인 후 시도해주세요." };
    }

    const supabase = await createClient();
    const { error } = await supabase
      .from("wholesalers")
      .update({ allow_price_negotiation: enabled })
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
