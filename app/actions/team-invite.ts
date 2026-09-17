"use server";

import { createClient } from "@/lib/supabase/server";
import { AUTH_CALLBACK_PATH, KAKAO_PROVIDER } from "@/lib/auth/supplier-auth";
import { TEAM_INVITE_INTENT, resolveSiteOrigin } from "@/lib/auth/team-invite";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * 직원 초대 링크(/join-team/<token>)에서 카카오 로그인 시작.
 * 콜백(?intent=team&invite_token=<token>)이 claim_organization_staff_invite()를 호출한다.
 */
export async function startTeamInviteKakaoLoginAction(
  token: string
): Promise<ActionResult<{ url: string }>> {
  try {
    const origin = await resolveSiteOrigin();
    const callbackUrl = new URL(AUTH_CALLBACK_PATH, origin);

    callbackUrl.searchParams.set("intent", TEAM_INVITE_INTENT);
    callbackUrl.searchParams.set("invite_token", token);

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
