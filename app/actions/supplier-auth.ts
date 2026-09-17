"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { getSupplierScope } from "@/lib/supplier/scope";
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

/**
 * 사업장 주소 입력 길이 제한 — 온보딩 폼과 /dashboard/invites 백필 폼이 공유한다.
 * 너무 짧으면 "-"류 무의미 입력을 막고, 너무 길면 PDF 레이아웃이 깨진다.
 */
const MIN_BUSINESS_ADDRESS_LENGTH = 5;
const MAX_BUSINESS_ADDRESS_LENGTH = 200;

/** 사업자등록증 사본 업로드 제한 — Storage 버킷 정책(business-licenses)과 별개로 앱 레벨에서도 확인한다. */
const MAX_BUSINESS_LICENSE_BYTES = 8 * 1024 * 1024;
const ALLOWED_BUSINESS_LICENSE_TYPES = ["image/jpeg", "image/png", "application/pdf"];

/** 미니샵 썸네일 업로드 제한 */
const MAX_SHOP_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const ALLOWED_SHOP_THUMBNAIL_TYPES = ["image/jpeg", "image/png"];

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
    const businessAddress = ((formData.get("business_address") as string) || "").trim();
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

    if (
      businessAddress.length < MIN_BUSINESS_ADDRESS_LENGTH ||
      businessAddress.length > MAX_BUSINESS_ADDRESS_LENGTH
    ) {
      throw new SupplierAuthError(
        "invalid_input",
        `사업장 주소를 ${MIN_BUSINESS_ADDRESS_LENGTH}~${MAX_BUSINESS_ADDRESS_LENGTH}자 이내로 정확히 입력해주세요.`
      );
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
      p_business_address: businessAddress,
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
 * 사업자등록증 사본 업로드 (공급사 본인).
 *
 * 파일은 Storage 버킷 business-licenses의 "<auth.uid()>/business-license" 경로에
 * 저장한다(확장자 없이 고정 — 재업로드 시 이전 파일 형식이 달라도 upsert로 항상
 * 같은 경로가 덮어써지게 함). wholesalers.business_license_path/uploaded_at는
 * business_address와 같은 이유로 SECURITY DEFINER RPC 없이 기존 RLS
 * ("Wholesalers updatable by self or admin")로 직접 UPDATE한다.
 */
export async function submitSupplierBusinessLicenseAction(
  formData: FormData
): Promise<ActionResult<{ path: string; uploadedAt: string }>> {
  try {
    const file = formData.get("business_license");

    if (!(file instanceof File) || file.size === 0) {
      throw new SupplierAuthError("invalid_input", "사업자등록증 파일을 선택해주세요.");
    }

    if (file.size > MAX_BUSINESS_LICENSE_BYTES) {
      throw new SupplierAuthError("invalid_input", "파일 용량은 8MB 이하만 업로드할 수 있습니다.");
    }

    if (!ALLOWED_BUSINESS_LICENSE_TYPES.includes(file.type)) {
      throw new SupplierAuthError("invalid_input", "JPG, PNG, PDF 파일만 업로드할 수 있습니다.");
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new SupplierAuthError("auth_required", "로그인이 필요합니다.");
    }

    const path = `${user.id}/business-license`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("business-licenses")
      .upload(path, buffer, { contentType: file.type, upsert: true });

    if (uploadError) {
      throw new Error("파일 업로드에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }

    const uploadedAt = new Date().toISOString();

    const { data, error } = await supabase
      .from("wholesalers")
      .update({ business_license_path: path, business_license_uploaded_at: uploadedAt })
      .eq("profile_id", user.id)
      .select("business_license_path, business_license_uploaded_at")
      .maybeSingle();

    if (error) {
      throw new Error("업로드 정보를 저장하지 못했습니다. 잠시 후 다시 시도해주세요.");
    }

    if (!data) {
      throw new SupplierAuthError(
        "not_a_supplier",
        "공급사 정보를 찾을 수 없습니다. 온보딩을 먼저 완료해주세요."
      );
    }

    revalidatePath("/dashboard", "layout");

    return {
      success: true,
      data: {
        path: data.business_license_path as string,
        uploadedAt: data.business_license_uploaded_at as string,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 미니샵 썸네일(업체 대표 사진/로고) 업로드 (대표 본인 또는 조직 owner/manager 직원).
 *
 * 상품/가격 테이블과 완전히 무관한 업체 단위 사진 하나라 가격 노출 가능성이 구조적으로
 * 없다. public 버킷이라 업로드 직후 바로 공개 URL을 만들 수 있다(서명된 URL 불필요).
 * wholesalers.shop_thumbnail_url 저장은 일반 RLS(profile_id=auth.uid()만 허용)로는
 * 조직 직원이 못 하므로 set_shop_thumbnail_url RPC로 우회한다(Storage 업로드 권한과
 * 동일한 can_manage_wholesaler_thumbnail() 판정을 재사용).
 */
export async function submitShopThumbnailAction(
  formData: FormData
): Promise<ActionResult<{ url: string }>> {
  try {
    const file = formData.get("shop_thumbnail");

    if (!(file instanceof File) || file.size === 0) {
      throw new SupplierAuthError("invalid_input", "썸네일 이미지를 선택해주세요.");
    }

    if (file.size > MAX_SHOP_THUMBNAIL_BYTES) {
      throw new SupplierAuthError("invalid_input", "이미지 용량은 4MB 이하만 업로드할 수 있습니다.");
    }

    if (!ALLOWED_SHOP_THUMBNAIL_TYPES.includes(file.type)) {
      throw new SupplierAuthError("invalid_input", "JPG, PNG 이미지만 업로드할 수 있습니다.");
    }

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      throw new SupplierAuthError(
        "not_a_supplier",
        "공급사 정보를 찾을 수 없습니다. 온보딩을 먼저 완료해주세요."
      );
    }

    const supabase = await createClient();
    const path = `${scope.wholesalerId}/thumbnail`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabase.storage
      .from("shop-thumbnails")
      .upload(path, buffer, { contentType: file.type, upsert: true });

    if (uploadError) {
      throw new Error("이미지 업로드에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from("shop-thumbnails").getPublicUrl(path);

    // 재업로드해도 경로가 같아 브라우저/CDN 캐시가 옛 이미지를 계속 보여줄 수 있어 무효화 파라미터를 붙인다.
    const url = `${publicUrl}?v=${Date.now()}`;

    const { error: rpcError } = await supabase.rpc("set_shop_thumbnail_url", {
      p_wholesaler_id: scope.wholesalerId,
      p_url: url,
    });

    if (rpcError) {
      throw toSupplierAuthError(
        rpcError.message,
        "썸네일 정보를 저장하지 못했습니다. 잠시 후 다시 시도해주세요."
      );
    }

    revalidatePath("/dashboard", "layout");

    return { success: true, data: { url } };
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
): Promise<ActionResult<{ businessNumber: string; businessStartDate: string }>> {
  try {
    const businessNumber = normalizeBusinessNumber((formData.get("business_number") as string) || "");
    const businessStartDate = ((formData.get("business_start_date") as string) || "").trim();

    if (!isValidBusinessNumber(businessNumber)) {
      throw new SupplierAuthError(
        "invalid_input",
        "사업자등록번호 10자리를 정확히 입력해주세요. (국세청 체크섬 불일치)"
      );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessStartDate) || new Date(businessStartDate) > new Date()) {
      throw new SupplierAuthError(
        "invalid_input",
        "개업일자를 정확히 입력해주세요. 국세청 진위확인에 필요합니다."
      );
    }

    const supabase = await createClient();

    const { data, error } = await supabase.rpc("submit_supplier_business_number", {
      p_business_number: businessNumber,
      p_business_start_date: businessStartDate,
    });

    if (error) {
      throw toSupplierAuthError(
        error.message,
        "사업자등록번호 제출에 실패했습니다. 잠시 후 다시 시도해주세요."
      );
    }

    const row = data as { business_number: string; business_start_date: string } | null;

    revalidatePath("/dashboard", "layout");

    return {
      success: true,
      data: {
        businessNumber: row?.business_number ?? businessNumber,
        businessStartDate: row?.business_start_date ?? businessStartDate,
      },
    };
  } catch (error) {
    return toResult(error);
  }
}

/**
 * 공급사(도매업체) 회원탈퇴 = 사업 종료(폐업) 처리.
 *
 * 업체 대표(가입 당사자) 본인만 실행 가능. 미수금이 남아있으면
 * withdraw_wholesaler_account() RPC가 OUTSTANDING_BALANCE_EXISTS로 거절한다.
 * 성공하면 wholesalers.status='closed'(상호/사업자정보는 유지 — 고객의 과거 거래
 * 기록 보존 목적)로 바뀌고, 실행 계정 본인의 profiles만 익명화된다. 로그인 차단은
 * 바이어 탈퇴와 동일하게 여기서 service_role Auth Admin API로 수행한다.
 */
export async function withdrawWholesalerAccountAction(): Promise<ActionResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new SupplierAuthError("auth_required", "로그인이 필요합니다.");
    }

    const { error: rpcError } = await supabase.rpc("withdraw_wholesaler_account");

    if (rpcError) {
      throw toSupplierAuthError(
        rpcError.message,
        "사업 종료 처리에 실패했습니다. 잠시 후 다시 시도해주세요."
      );
    }

    const admin = createServiceRoleClient();

    if (admin) {
      // 사실상 영구 차단(약 100년). Supabase는 무기한 값을 별도로 지원하지 않는다.
      const { error: banError } = await admin.auth.admin.updateUserById(user.id, {
        ban_duration: "876000h",
      });

      if (banError) {
        console.error("[Wholesaler Withdrawal] 계정 정지 실패:", banError.message);
      }
    } else {
      console.error(
        "[Wholesaler Withdrawal] SUPABASE_SERVICE_ROLE_KEY가 없어 계정을 정지할 수 없습니다."
      );
    }

    await supabase.auth.signOut();

    revalidatePath("/", "layout");

    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}
