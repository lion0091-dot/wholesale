"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  AUTH_CALLBACK_PATH,
  BuyerAuthError,
  KAKAO_PROVIDER,
  claimShopAccess,
  isValidShopToken,
  resolveSiteOrigin,
  sanitizeShopReturnPath,
} from "@/lib/auth/buyer-auth";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof BuyerAuthError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/**
 * 카카오 로그인 시작.
 *
 * 서버에서 OAuth 인가 URL만 만들어 돌려주고, 실제 이동은 클라이언트가 수행한다.
 * (카카오 인앱 브라우저에서 서버 리다이렉트가 팝업 차단에 걸리는 경우를 피한다)
 *
 * 로그인 성공 후 /auth/callback 이 코드를 세션으로 교환하고
 * claim_shop_access() 로 retailer_id 매핑까지 마친 뒤 원래 미니샵으로 복귀시킨다.
 */
export async function startKakaoLoginAction(
  shopToken: string,
  returnPath?: string
): Promise<ActionResult<{ url: string }>> {
  try {
    if (!isValidShopToken(shopToken)) {
      throw new BuyerAuthError("invalid_shop", "올바른 미니샵 주소가 아닙니다.");
    }

    const nextPath = sanitizeShopReturnPath(returnPath) ?? `/shop/${shopToken}`;
    const origin = await resolveSiteOrigin();
    const callbackUrl = new URL(AUTH_CALLBACK_PATH, origin);

    callbackUrl.searchParams.set("next", nextPath);
    callbackUrl.searchParams.set("shop_token", shopToken);

    const supabase = await createClient();

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: KAKAO_PROVIDER,
      options: {
        redirectTo: callbackUrl.toString(),
        // 카카오는 기본 동의항목(닉네임/프로필)만으로 3초 로그인이 성립한다.
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
    return toResult(error);
  }
}

/**
 * 단골 등록(초대 링크 클레임) 수동 재시도.
 * 콜백에서 이미 자동 실행되지만, 다른 경로로 먼저 로그인한 계정이
 * 새 공급사 링크를 열었을 때 이 버튼으로 연결을 맺는다.
 */
export async function claimShopAccessAction(
  shopToken: string
): Promise<ActionResult<{ isLinked: boolean; businessName: string }>> {
  try {
    const result = await claimShopAccess(shopToken);

    revalidatePath(`/shop/${shopToken}`);
    revalidatePath(`/shop/${shopToken}/orders`);

    if (!result.isLinked) {
      return {
        success: false,
        error: "공급사가 거래를 차단한 상태입니다. 공급사에 직접 문의해주세요.",
      };
    }

    return {
      success: true,
      data: { isLinked: result.isLinked, businessName: result.businessName },
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 바이어 이용약관/개인정보 수집·이용 동의 기록.
 *
 * 카카오 로그인 직후 아직 동의를 받지 않은 상태(profiles.terms_agreed_at IS NULL)면
 * 미니샵 카탈로그 대신 동의 화면이 먼저 뜬다. 이 액션이 그 화면의 제출을 처리한다.
 * (record_buyer_consent()는 role='retailer' 계정 본인의 profiles만 갱신하고,
 *  이미 동의했으면 재호출해도 덮어쓰지 않는다 — 멱등)
 */
export async function recordBuyerConsentAction(
  shopToken: string,
  formData: FormData
): Promise<ActionResult> {
  try {
    if (!isValidShopToken(shopToken)) {
      throw new BuyerAuthError("invalid_shop", "올바른 미니샵 주소가 아닙니다.");
    }

    const agreedTerms = formData.get("agree_terms") === "on";
    const agreedPrivacy = formData.get("agree_privacy") === "on";
    const agreedMarketing = formData.get("agree_marketing") === "on";

    if (!agreedTerms || !agreedPrivacy) {
      return {
        success: false,
        error: "서비스 이용약관과 개인정보 수집·이용에 모두 동의해야 이용할 수 있습니다.",
      };
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc("record_buyer_consent", {
      p_marketing_agreed: agreedMarketing,
    });

    if (error) {
      return {
        success: false,
        error: "동의 처리에 실패했습니다. 잠시 후 다시 시도해주세요.",
      };
    }

    revalidatePath(`/shop/${shopToken}`);

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

/** 미니샵 로그아웃 (기기 공유 상황 대비) */
export async function signOutBuyerAction(shopToken: string): Promise<ActionResult> {
  try {
    const supabase = await createClient();

    await supabase.auth.signOut();

    revalidatePath(`/shop/${shopToken}`);

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}
