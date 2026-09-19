"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import {
  AUTH_CALLBACK_PATH,
  BuyerAuthError,
  KAKAO_PROVIDER,
  claimShopAccess,
  isValidShopToken,
  resolveSiteOrigin,
  sanitizeShopReturnPath,
} from "@/lib/auth/buyer-auth";
import { isValidBusinessNumber, normalizeBusinessNumber } from "@/lib/validation/business-number";

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

export interface RetailerProfileInput {
  restaurantName: string;
  representativeName: string;
  businessNumber: string;
  deliveryAddress: string;
  deliveryAddressDetail: string;
  contactPhone: string;
}

/**
 * 바이어(구매회원) 본인 정보 수정 — 상호명/대표자명/사업자번호/배송지/연락처.
 *
 * claim_shop_access()는 카카오 닉네임만으로 거래처 행을 만들고, 첫 주문 때
 * backfillRetailerProfile()이 비어있는 값만 한 번 채운다(app/shop/[shop_token]/actions.ts).
 * 그 이후로는 본인도 공급사도 이 정보를 고칠 방법이 없었다 — 거래명세서/계산서(면세)가
 * 이 값을 매번 실시간으로 읽어서 만들어지므로(lib/orders/statement.ts, 스냅샷 아님),
 * 여기서 고치면 과거에 발행한 주문 건도 다시 열람/다운로드할 때 자동으로 최신 정보로
 * 나온다 — 별도 소급 처리가 필요 없다.
 *
 * business_address와 같은 이유로 SECURITY DEFINER RPC 없이 기존 RLS로 직접 UPDATE한다.
 * 사업자번호는 선택 입력(소매는 국세청 진위확인 대상이 아니다) — 입력했으면 체크섬만 확인한다.
 */
export async function updateRetailerProfileAction(
  input: RetailerProfileInput
): Promise<ActionResult> {
  try {
    const restaurantName = input.restaurantName.trim();
    const representativeName = input.representativeName.trim();
    const deliveryAddress = input.deliveryAddress.trim();
    const deliveryAddressDetail = input.deliveryAddressDetail.trim();
    const contactPhone = input.contactPhone.replace(/\D/g, "");
    const businessNumberRaw = normalizeBusinessNumber(input.businessNumber);

    if (restaurantName.length < 2 || restaurantName.length > 40) {
      throw new BuyerAuthError("invalid_input", "상호(사업장)명을 2~40자 이내로 입력해주세요.");
    }

    if (representativeName.length < 2 || representativeName.length > 30) {
      throw new BuyerAuthError("invalid_input", "대표자명을 2~30자 이내로 입력해주세요.");
    }

    if (deliveryAddress.length < 5 || deliveryAddress.length > 200) {
      throw new BuyerAuthError("invalid_input", "배송지 주소를 5~200자 이내로 정확히 입력해주세요.");
    }

    if (deliveryAddressDetail.length > 100) {
      throw new BuyerAuthError("invalid_input", "상세주소는 100자 이내로 입력해주세요.");
    }

    if (contactPhone.length < 9 || contactPhone.length > 11) {
      throw new BuyerAuthError("invalid_input", "연락처를 정확히 입력해주세요. (숫자만 9~11자리)");
    }

    if (businessNumberRaw && !isValidBusinessNumber(businessNumberRaw)) {
      throw new BuyerAuthError(
        "invalid_input",
        "사업자등록번호 체크섬이 올바르지 않습니다. 번호를 다시 확인해주세요. (미입력 후 나중에 등록도 가능합니다)"
      );
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new BuyerAuthError("auth_required", "로그인이 필요합니다.");
    }

    const { data, error } = await supabase
      .from("retailers")
      .update({
        restaurant_name: restaurantName,
        representative_name: representativeName,
        business_number: businessNumberRaw || null,
        delivery_address: deliveryAddress,
        delivery_address_detail: deliveryAddressDetail || null,
        updated_at: new Date().toISOString(),
      })
      .eq("profile_id", user.id)
      .select("id")
      .maybeSingle();

    if (error) {
      throw new Error("정보 저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }

    if (!data) {
      throw new BuyerAuthError(
        "profile_missing",
        "거래처 정보를 찾을 수 없습니다. 초대 링크로 먼저 접속해주세요."
      );
    }

    const { error: phoneError } = await supabase
      .from("profiles")
      .update({ phone: contactPhone, updated_at: new Date().toISOString() })
      .eq("id", user.id);

    if (phoneError) {
      console.error("[Retailer Profile] 연락처 저장 오류:", phoneError.message);
      throw new Error("연락처 저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }

    revalidatePath("/my-shops");

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 바이어(구매회원) 회원탈퇴.
 *
 * 완전 삭제가 아니라 "개인정보 익명화(withdraw_retailer_account RPC) + 로그인 영구 차단"으로
 * 처리한다. orders/order_items는 손대지 않는다(전자상거래법상 계약/결제 기록 보관 의무).
 *
 * 로그인 차단은 Postgres RPC가 아니라 여기(서버 액션)에서 service_role Auth Admin API로
 * 수행한다 — auth.users는 Supabase가 관리하는 스키마라 공식 API(ban_duration)만 쓴다.
 * SUPABASE_SERVICE_ROLE_KEY가 없는 데모 환경에서는 익명화만 되고 차단은 건너뛴다
 * (개발 편의 — 실제 배포 환경에는 항상 키가 있어야 한다).
 */
export async function withdrawBuyerAccountAction(): Promise<ActionResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new BuyerAuthError("auth_required", "로그인이 필요합니다.");
    }

    const { error: rpcError } = await supabase.rpc("withdraw_retailer_account");

    if (rpcError) {
      const message = rpcError.message ?? "";

      if (message.includes("NOT_A_RETAILER_ACCOUNT")) {
        throw new BuyerAuthError("not_a_buyer", "고객(소매) 계정만 탈퇴할 수 있습니다.");
      }

      if (message.includes("RETAILER_NOT_FOUND")) {
        throw new BuyerAuthError("profile_missing", "회원 정보를 찾을 수 없습니다.");
      }

      throw new Error("탈퇴 처리에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }

    const admin = createServiceRoleClient();

    if (admin) {
      // 사실상 영구 차단(약 100년). Supabase는 무기한 값을 별도로 지원하지 않는다.
      const { error: banError } = await admin.auth.admin.updateUserById(user.id, {
        ban_duration: "876000h",
      });

      if (banError) {
        console.error("[Buyer Withdrawal] 계정 정지 실패:", banError.message);
      }
    } else {
      console.error("[Buyer Withdrawal] SUPABASE_SERVICE_ROLE_KEY가 없어 계정을 정지할 수 없습니다.");
    }

    await supabase.auth.signOut();

    revalidatePath("/", "layout");

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
