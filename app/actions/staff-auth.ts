"use server";

import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/auth/buyer-auth";
import { AUTH_CALLBACK_PATH, KAKAO_PROVIDER, STAFF_INTENT } from "@/lib/auth/staff-auth";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * 내부 스태프 카카오 로그인/가입 시작.
 *
 * 카카오 OAuth 자체는 startSupplierKakaoLoginAction과 동일하지만 콜백에
 * intent=staff를 실어 보낸다 — /auth/callback이 이 값을 보고 온보딩(업체 등록)
 * 대신 STAFF_PENDING_PATH로 보낸다. next 경로를 받지 않는 이유: 스태프 흐름은
 * 항상 같은 안내 화면 하나로만 도착해야 하고(임의 목적지로 가면 권한 없이 백오피스에
 * 들어가려는 시도와 구분이 어려워진다), 승인 후 실제 목적지는 재로그인 시
 * getLandingPathForRole("super_admin")이 정한다.
 */
export async function startStaffKakaoLoginAction(): Promise<ActionResult<{ url: string }>> {
  try {
    const origin = await resolveSiteOrigin();
    const callbackUrl = new URL(AUTH_CALLBACK_PATH, origin);

    callbackUrl.searchParams.set("intent", STAFF_INTENT);

    const supabase = await createClient();

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: KAKAO_PROVIDER,
      options: {
        redirectTo: callbackUrl.toString(),
        queryParams: { prompt: "select_account" },
      },
    });

    if (error || !data?.url) {
      return {
        success: false,
        error: error?.message ?? "카카오 로그인을 시작할 수 없습니다. 잠시 후 다시 시도해주세요.",
      };
    }

    return { success: true, data: { url: data.url } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
    };
  }
}
