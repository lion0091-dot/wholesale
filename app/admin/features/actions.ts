"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdminSession } from "@/lib/auth/rbac";

export interface FeatureActionResult {
  success: boolean;
  error?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERRORS: Record<string, string> = {
  FORBIDDEN: "플랫폼 운영자만 바꿀 수 있습니다.",
  UNKNOWN_FEATURE: "없는 기능입니다.",
  WHOLESALER_NOT_FOUND: "없는 업체입니다.",
  INVALID_CONFIG: "세부 설정이 올바르지 않습니다.",
};

/** 업체의 기능을 켜거나 끈다. 켜고 끄는 건 운영자(슈퍼관리자)만 — DB 함수가 한 번 더 막는다. */
export async function setWholesalerFeatureAction(
  wholesalerId: string,
  featureKey: string,
  enabled: boolean
): Promise<FeatureActionResult> {
  if (!(await isSuperAdminSession())) {
    return { success: false, error: ERRORS.FORBIDDEN };
  }

  if (!UUID_PATTERN.test(wholesalerId) || !/^[a-z][a-z0-9_]*$/.test(featureKey)) {
    return { success: false, error: "요청이 올바르지 않습니다." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_wholesaler_feature", {
    p_wholesaler_id: wholesalerId,
    p_key: featureKey,
    p_enabled: enabled,
  });

  if (error) {
    const code = Object.keys(ERRORS).find((key) => error.message.includes(key));

    return { success: false, error: code ? ERRORS[code] : "저장하지 못했습니다. 잠시 후 다시 시도해주세요." };
  }

  revalidatePath("/admin/features");
  return { success: true };
}
