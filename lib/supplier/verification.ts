/**
 * 공급사 계정 상태 / 승인(행정 검증) 판정.
 *
 * 권한 모델:
 *   is_supplier = true, is_verified = false → Pending Supplier
 *       상품 등록·단가·발주·마이페이지 등 기본 기능은 정회원과 동일하게 허용하고,
 *       핵심 영업 기능인 '초대장 발부'만 차단한다.
 *   is_supplier = true, is_verified = true  → 정회원 공급사
 *
 * 승인은 업체(wholesalers) 단위 행위이고 플래그는 계정(profiles)에 있다.
 * 승인 시 set_supplier_verification()이 조직 직원 전원에게 플래그를 전파하지만,
 * 전파 이전에 합류한 직원이 초대장을 못 쓰는 일이 없도록 업체 status='active'도
 * 승인 근거로 함께 인정한다.
 */

import { createClient } from "@/lib/supabase/server";
import { resolveDisplayName, resolveKakaoNickname } from "@/lib/auth/display-name";
import type { UserRole, WholesalerStatus } from "@/types/database";

export interface SupplierAccount {
  userId: string;
  email: string | null;
  name: string | null;
  /**
   * 화면 표시용 이름. profiles.name → 카카오 닉네임 → "사용자" 순으로 해석되며
   * 항상 값이 있다. 이메일 없는 카카오 계정에서도 안전하게 쓸 수 있다.
   */
  displayName: string;
  phone: string | null;
  /**
   * 카카오 세션(user_metadata)에서 읽은 이름/전화 제안값. DB(profiles)에는
   * 저장되지 않은 값이라 폼 프리필 용도로만 쓴다 — 동의(complete_supplier_signup)
   * 전에는 profiles.name/phone이 항상 비어 있으므로 이 값으로 대신 채운다.
   */
  kakaoName: string | null;
  kakaoPhone: string | null;
  platformRole: UserRole | null;
  isSuperAdmin: boolean;
  isSupplier: boolean;
  /** 행정 승인 완료 여부 (profiles.is_verified) */
  isVerified: boolean;
  /** 필수 약관 동의 시각 — null이면 최소 정보 입력 전 단계 */
  termsAgreedAt: string | null;
  organizationId: string | null;
  wholesalerId: string | null;
  businessName: string | null;
  businessNumber: string | null;
  /** 사업장 주소 — 거래명세서 PDF 발행에 필수. null이면 발행이 막힌다 */
  businessAddress: string | null;
  shopToken: string | null;
  supplierStatus: WholesalerStatus | null;
  /** 최소 정보(약관 + 연락처 + 상호) 입력이 남아 있는지 */
  needsMinimumInfo: boolean;
  /** 초대장(미니샵 초대 링크) 발부 가능 여부 */
  canIssueInvite: boolean;
}

/** 미승인 공급사에게 노출하는 공통 안내 문구 */
export const PENDING_VERIFICATION_NOTICE =
  "현재 행정 절차 및 승인 심사 진행 중입니다. 기본 기능은 이용 가능하며, 승인 완료 시 초대장 발부 기능이 활성화됩니다.";

/** 사업자등록번호 미제출 상태에서 추가로 덧붙이는 안내 */
export const BUSINESS_NUMBER_REQUIRED_NOTICE =
  "사업자등록번호가 아직 제출되지 않았습니다. 번호를 등록하면 승인 심사가 시작됩니다.";

/**
 * 현재 세션의 공급사 계정 상태를 한 번에 조회한다.
 * 미인증(데모 모드 포함)이면 null — 호출부가 샘플 데이터로 대체한다.
 */
export async function getSupplierAccount(): Promise<SupplierAccount | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const [{ data: profile }, { data: staff }] = await Promise.all([
    supabase
      .from("profiles")
      .select("role, name, phone, is_supplier, is_verified, terms_agreed_at")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("organization_staff")
      .select("organization_id")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const platformRole = (profile?.role as UserRole | undefined) ?? null;
  const organizationId = (staff?.organization_id as string | undefined) ?? null;

  // 업체 레코드 해석 순서: 조직에 연결된 업체 → 본인 소유 업체
  // (직원 계정은 자기 profile_id로 wholesalers를 찾을 수 없다)
  let linkedWholesalerId: string | null = null;

  if (organizationId) {
    const { data: organization } = await supabase
      .from("organizations")
      .select("wholesaler_id")
      .eq("id", organizationId)
      .maybeSingle();

    linkedWholesalerId = (organization?.wholesaler_id as string | null) ?? null;
  }

  const { data: wholesaler } = linkedWholesalerId
    ? await supabase
        .from("wholesalers")
        .select("id, business_name, business_number, business_address, shop_token, status")
        .eq("id", linkedWholesalerId)
        .maybeSingle()
    : await supabase
        .from("wholesalers")
        .select("id, business_name, business_number, business_address, shop_token, status")
        .eq("profile_id", user.id)
        .maybeSingle();

  const kakaoName = resolveKakaoNickname(user.user_metadata);
  const kakaoPhone =
    (typeof user.user_metadata?.phone_number === "string"
      ? user.user_metadata.phone_number.trim() || null
      : null) ?? (user.phone || null);

  const isSuperAdmin = platformRole === "super_admin";
  const isSupplier = (profile?.is_supplier as boolean | undefined) ?? platformRole === "wholesaler";
  const isVerified = (profile?.is_verified as boolean | undefined) ?? false;
  const supplierStatus = (wholesaler?.status as WholesalerStatus | undefined) ?? null;
  const shopToken = (wholesaler?.shop_token as string | undefined) ?? null;

  // 업체 레코드가 아직 없으면 상호/연락처를 받지 않은 상태다.
  const needsMinimumInfo =
    isSupplier && !isSuperAdmin && (!profile?.terms_agreed_at || !wholesaler?.id);

  const administrativelyApproved = isVerified || supplierStatus === "active";

  return {
    userId: user.id,
    email: user.email ?? null,
    name: (profile?.name as string | undefined) ?? null,
    displayName: resolveDisplayName(
      profile?.name as string | null | undefined,
      user.user_metadata
    ),
    phone: (profile?.phone as string | undefined) ?? null,
    kakaoName,
    kakaoPhone,
    platformRole,
    isSuperAdmin,
    isSupplier,
    isVerified,
    termsAgreedAt: (profile?.terms_agreed_at as string | null | undefined) ?? null,
    organizationId,
    wholesalerId: (wholesaler?.id as string | undefined) ?? null,
    businessName: (wholesaler?.business_name as string | undefined) ?? null,
    businessNumber: (wholesaler?.business_number as string | null | undefined) ?? null,
    businessAddress: (wholesaler?.business_address as string | null | undefined) ?? null,
    shopToken,
    supplierStatus,
    needsMinimumInfo,
    canIssueInvite: Boolean(
      shopToken &&
        (isSuperAdmin || (isSupplier && administrativelyApproved && supplierStatus !== "suspended"))
    ),
  };
}

/** 미승인 사유를 사용자 안내 문구로 변환한다. (승인 완료면 null) */
export function describeInviteRestriction(account: SupplierAccount): string | null {
  if (account.canIssueInvite) {
    return null;
  }

  if (!account.isSupplier && !account.isSuperAdmin) {
    return "공급사 계정만 초대장을 발부할 수 있습니다.";
  }

  if (account.supplierStatus === "suspended") {
    return "구독료 미납 또는 운영 정책 위반으로 이용이 일시정지된 상태입니다. 플랫폼 운영팀에 문의해주세요.";
  }

  if (account.supplierStatus === "rejected") {
    return "입점 심사가 거절된 상태입니다. 사업자 정보를 확인한 뒤 운영팀에 재심사를 요청해주세요.";
  }

  if (!account.wholesalerId) {
    return "공급사 기본 정보(상호·연락처) 입력이 완료되지 않아 초대장을 발부할 수 없습니다.";
  }

  return PENDING_VERIFICATION_NOTICE;
}
