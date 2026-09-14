"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  AUTH_CALLBACK_PATH,
  KAKAO_PROVIDER,
  SUPPLIER_INTENT,
  SupplierAuthError,
  resolveSiteOrigin,
  sanitizeSupplierReturnPath,
  toSupplierAuthError,
} from "@/lib/auth/supplier-auth";
import { isValidBusinessNumber, normalizeBusinessNumber } from "@/lib/validation/business-number";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof SupplierAuthError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/**
 * 공급사 카카오 로그인/가입 시작. (로그인과 가입이 같은 버튼이다)
 *
 * 서버에서 OAuth 인가 URL만 만들어 돌려주고 실제 이동은 클라이언트가 수행한다.
 * (카카오 인앱 브라우저에서 서버 리다이렉트가 팝업 차단에 걸리는 경우를 피한다)
 */
export async function startSupplierKakaoLoginAction(
  returnPath?: string
): Promise<ActionResult<{ url: string }>> {
  try {
    const nextPath = sanitizeSupplierReturnPath(returnPath);
    const origin = await resolveSiteOrigin();
    const callbackUrl = new URL(AUTH_CALLBACK_PATH, origin);

    callbackUrl.searchParams.set("intent", SUPPLIER_INTENT);

    if (nextPath) {
      callbackUrl.searchParams.set("next", nextPath);
    }

    const supabase = await createClient();

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: KAKAO_PROVIDER,
      options: {
        redirectTo: callbackUrl.toString(),
        // 카카오 기본 동의항목(닉네임/프로필)만으로 3초 가입이 성립한다.
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

export interface SupplierSignupResult {
  wholesalerId: string;
  organizationId: string | null;
  shopToken: string | null;
  businessNumberSubmitted: boolean;
}

/**
 * 최소 정보 제출 = 공급사 온보딩 완료.
 *
 * 약관 동의 + 연락처 + 상호만 받고 즉시 백오피스 사용을 허용한다.
 * 사업자등록번호는 선택 입력이며, 제출 + 슈퍼관리자 승인이 끝나야
 * is_verified = true 가 되어 초대장 발부가 열린다.
 *
 * profiles / wholesalers / organizations / organization_staff 를 한 트랜잭션으로
 * 세워야 하므로 DB 함수(complete_supplier_signup)에 위임한다.
 */
export async function completeSupplierSignupAction(
  formData: FormData
): Promise<ActionResult<SupplierSignupResult>> {
  try {
    const businessName = ((formData.get("business_name") as string) || "").trim();
    const representativeName = ((formData.get("representative_name") as string) || "").trim();
    const phone = ((formData.get("phone") as string) || "").replace(/\D/g, "");
    const businessNumberRaw = normalizeBusinessNumber(
      (formData.get("business_number") as string) || ""
    );
    const agreedTerms = formData.get("agree_terms") === "on";
    const agreedPrivacy = formData.get("agree_privacy") === "on";
    const agreedMarketing = formData.get("agree_marketing") === "on";

    if (!agreedTerms || !agreedPrivacy) {
      throw new SupplierAuthError(
        "invalid_input",
        "서비스 이용약관과 개인정보 수집·이용에 모두 동의해야 가입이 완료됩니다."
      );
    }

    if (businessName.length < 2) {
      throw new SupplierAuthError("invalid_input", "상호(업체명)를 2자 이상 입력해주세요.");
    }

    if (representativeName.length < 2) {
      throw new SupplierAuthError("invalid_input", "담당자(대표자) 성명을 입력해주세요.");
    }

    if (phone.length < 9 || phone.length > 11) {
      throw new SupplierAuthError("invalid_input", "연락처를 정확히 입력해주세요. (숫자만 9~11자리)");
    }

    if (businessNumberRaw && !isValidBusinessNumber(businessNumberRaw)) {
      throw new SupplierAuthError(
        "invalid_input",
        "사업자등록번호 체크섬이 올바르지 않습니다. 번호를 다시 확인해주세요. (미입력 후 나중에 등록도 가능합니다)"
      );
    }

    const supabase = await createClient();

    const { data, error } = await supabase.rpc("complete_supplier_signup", {
      p_business_name: businessName,
      p_representative_name: representativeName,
      p_phone: phone,
      p_business_number: businessNumberRaw || null,
      p_marketing_agreed: agreedMarketing,
    });

    if (error) {
      throw toSupplierAuthError(error.message, "가입 처리에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }

    const row = data as {
      wholesaler_id: string;
      organization_id: string | null;
      shop_token: string | null;
      business_number_submitted: boolean;
    } | null;

    if (!row) {
      throw new SupplierAuthError("signup_failed", "가입 결과를 확인할 수 없습니다. 다시 시도해주세요.");
    }

    revalidatePath("/", "layout");

    return {
      success: true,
      data: {
        wholesalerId: row.wholesaler_id,
        organizationId: row.organization_id,
        shopToken: row.shop_token,
        businessNumberSubmitted: row.business_number_submitted,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/** 사업장 주소 입력 길이 제한 — 너무 짧으면 "-"류 무의미 입력을 막고, 너무 길면 PDF 레이아웃이 깨진다 */
const MIN_BUSINESS_ADDRESS_LENGTH = 5;
const MAX_BUSINESS_ADDRESS_LENGTH = 200;

/**
 * 사업장 주소 등록/수정 (공급사 본인).
 *
 * business_number와 달리 승인 후 잠금·중복 검사·organizations 동기화가 필요 없어
 * SECURITY DEFINER RPC 없이 RLS("Wholesalers updatable by self or admin")가
 * 허용하는 범위 내에서 직접 UPDATE한다.
 *
 * 거래명세서 PDF(lib/orders/statement.ts)의 공급자란이 이 값을 그대로 쓰고,
 * 비어 있으면 PDF 라우트가 발행 자체를 막는다.
 */
export async function submitSupplierBusinessAddressAction(
  formData: FormData
): Promise<ActionResult<{ businessAddress: string }>> {
  try {
    const businessAddress = ((formData.get("business_address") as string) || "").trim();

    if (
      businessAddress.length < MIN_BUSINESS_ADDRESS_LENGTH ||
      businessAddress.length > MAX_BUSINESS_ADDRESS_LENGTH
    ) {
      throw new SupplierAuthError(
        "invalid_input",
        `사업장 주소를 ${MIN_BUSINESS_ADDRESS_LENGTH}~${MAX_BUSINESS_ADDRESS_LENGTH}자 이내로 정확히 입력해주세요.`
      );
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new SupplierAuthError("auth_required", "로그인이 필요합니다.");
    }

    const { data, error } = await supabase
      .from("wholesalers")
      .update({ business_address: businessAddress })
      .eq("profile_id", user.id)
      .select("business_address")
      .maybeSingle();

    if (error) {
      throw new Error("사업장 주소 저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }

    if (!data) {
      throw new SupplierAuthError(
        "not_a_supplier",
        "공급사 정보를 찾을 수 없습니다. 온보딩을 먼저 완료해주세요."
      );
    }

    revalidatePath("/dashboard", "layout");

    return { success: true, data: { businessAddress: data.business_address as string } };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 승인 심사용 사업자등록번호 제출/수정 (미승인 공급사 본인).
 * 승인 완료 후에는 업체 동일성이 흔들리면 안 되므로 DB 함수가 재제출을 막는다.
 */
export async function submitSupplierBusinessNumberAction(
  formData: FormData
): Promise<ActionResult<{ businessNumber: string }>> {
  try {
    const businessNumber = normalizeBusinessNumber((formData.get("business_number") as string) || "");

    if (!isValidBusinessNumber(businessNumber)) {
      throw new SupplierAuthError(
        "invalid_input",
        "사업자등록번호 10자리를 정확히 입력해주세요. (국세청 체크섬 불일치)"
      );
    }

    const supabase = await createClient();

    const { data, error } = await supabase.rpc("submit_supplier_business_number", {
      p_business_number: businessNumber,
    });

    if (error) {
      throw toSupplierAuthError(
        error.message,
        "사업자등록번호 제출에 실패했습니다. 잠시 후 다시 시도해주세요."
      );
    }

    const row = data as { business_number: string } | null;

    revalidatePath("/dashboard", "layout");

    return { success: true, data: { businessNumber: row?.business_number ?? businessNumber } };
  } catch (error) {
    return toResult(error);
  }
}
