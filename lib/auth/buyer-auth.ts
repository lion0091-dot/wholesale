/**
 * 바이어(구매 회원) 인증 — 카카오 OAuth 단일 채널.
 *
 * 인증 흐름:
 *   알림톡 링크(/shop/<shop_token>) 진입
 *     → 미로그인이면 [카카오로 3초 시작하기] 게이트
 *     → Supabase Auth 카카오 OAuth (최초 1회)
 *     → /auth/callback 에서 claim_shop_access() 호출
 *     → auth.uid() ↔ profiles ↔ retailers ↔ wholesaler_retailers 매핑 확정
 *     → 이후 재로그인 불필요 (Auth 세션 자동 갱신)
 *
 * 신원 판정 근거는 auth.uid() 하나뿐이다. 서명 쿠키(wsale_customer_session) 방식은
 * 링크가 유출되면 타인이 그대로 대리 조작할 수 있어 폐기했다.
 *
 * 서버 전용 모듈(next/headers 의존).
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types/database";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export const KAKAO_PROVIDER = "kakao";

/** OAuth 왕복 후 되돌아올 콜백 경로 */
export const AUTH_CALLBACK_PATH = "/auth/callback";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 사용자에게 그대로 보여줄 안내 문구를 담은 인증/권한 오류 */
export class BuyerAuthError extends Error {
  readonly code: BuyerAuthErrorCode;

  constructor(code: BuyerAuthErrorCode, message: string) {
    super(message);
    this.name = "BuyerAuthError";
    this.code = code;
  }
}

export type BuyerAuthErrorCode =
  | "auth_required"
  | "not_a_buyer"
  | "profile_missing"
  | "invalid_shop"
  | "not_linked";

export function isValidShopToken(shopToken: string | null | undefined): boolean {
  return Boolean(shopToken) && UUID_PATTERN.test(shopToken as string);
}

/**
 * OAuth 복귀 경로 검증.
 * 오픈 리다이렉트를 막기 위해 `/shop/<uuid>` 하위 내부 경로만 허용한다.
 */
export function sanitizeShopReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/shop/")) {
    return null;
  }

  // "//host", "/\host" → 프로토콜 상대 URL(외부 도메인)로 해석될 수 있다.
  if (raw.startsWith("//") || raw.includes("\\")) {
    return null;
  }

  const [, , token] = raw.split("?")[0].split("#")[0].split("/");

  return isValidShopToken(token) ? raw : null;
}

/**
 * OAuth redirectTo 에 쓸 절대 origin.
 * 프록시 뒤에서도 정확한 값을 얻기 위해 NEXT_PUBLIC_SITE_URL 을 우선한다.
 * (Supabase 대시보드의 Redirect URLs 에 동일 origin 이 등록되어 있어야 한다)
 */
export async function resolveSiteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();

  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");

  if (!host) {
    throw new BuyerAuthError(
      "auth_required",
      "서비스 주소를 확인할 수 없어 카카오 로그인을 시작할 수 없습니다. NEXT_PUBLIC_SITE_URL을 설정해주세요."
    );
  }

  const proto = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");

  return `${proto}://${host}`;
}

// ====================================================================
// 미니샵 진입 게이트
// ====================================================================

export interface PublicShopIdentity {
  wholesalerId: string;
  businessName: string;
  representativeName: string;
}

/**
 * 로그인 게이트에 노출할 공급사 상호.
 * 신규 바이어는 아직 거래 관계가 없어 wholesalers 테이블을 직접 읽을 수 없으므로
 * 상호/대표자만 돌려주는 SECURITY DEFINER 함수를 사용한다.
 */
export async function loadPublicShopIdentity(
  shopToken: string
): Promise<PublicShopIdentity | null> {
  if (!isValidShopToken(shopToken)) {
    return null;
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc("get_public_shop_identity", { p_shop_token: shopToken })
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const row = data as {
    wholesaler_id: string;
    business_name: string;
    representative_name: string;
  };

  return {
    wholesalerId: row.wholesaler_id,
    businessName: row.business_name,
    representativeName: row.representative_name,
  };
}

// ====================================================================
// 바이어 신원 해석 (auth.uid() 기준)
// ====================================================================

export interface BuyerIdentity {
  userId: string;
  role: UserRole | null;
  retailerId: string | null;
  restaurantName: string | null;
  representativeName: string | null;
  contactPhone: string | null;
  deliveryAddress: string | null;
  /** 이 공급사와 활성(active) 거래 관계가 확인된 단골 여부 */
  isLinked: boolean;
  /** 여신 한도 (0이면 외상 거래 불가). 미연결 상태면 0 */
  creditLimit: number;
  /** 공급사가 이 거래처에 열어준 결제수단. 미연결 상태면 빈 배열 */
  allowedPaymentMethods: string[];
}

/** 거래 관계까지 확인된 바이어 — 발주/취소 요청의 전제 조건 */
export interface LinkedBuyer {
  userId: string;
  retailerId: string;
  restaurantName: string;
  contactPhone: string | null;
  deliveryAddress: string | null;
  wholesalerId: string;
  wholesalerName: string;
  wholesalerProfileId: string;
  /** wholesaler_retailers.id — 외상 주문 시 apply_credit_order RPC 대상 식별자 */
  relationshipId: string;
  creditLimit: number;
  outstandingBalance: number;
  /** 공급사가 이 거래처에 열어준 결제수단 */
  allowedPaymentMethods: string[];
}

/**
 * 현재 Auth 세션으로 바이어 신원을 해석한다.
 * 미로그인/식당 미등록이면 null 필드를 채워 돌려주고 예외를 던지지 않는다.
 * (카탈로그 화면은 미인증 상태도 표현해야 하므로)
 */
export async function resolveBuyerIdentity(
  supabase: SupabaseServerClient,
  wholesalerId: string | null
): Promise<BuyerIdentity | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, phone")
    .eq("id", user.id)
    .maybeSingle();

  const role = (profile?.role as UserRole | undefined) ?? null;

  // 공급사/관리자 계정은 고객으로 취급하지 않는다 (경쟁사 염탐 차단).
  if (role === "wholesaler" || role === "super_admin") {
    return {
      userId: user.id,
      role,
      retailerId: null,
      restaurantName: null,
      representativeName: null,
      contactPhone: null,
      deliveryAddress: null,
      isLinked: false,
      creditLimit: 0,
      allowedPaymentMethods: [],
    };
  }

  const { data: retailer } = await supabase
    .from("retailers")
    .select("id, restaurant_name, representative_name, delivery_address, delivery_address_detail")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (!retailer) {
    return {
      userId: user.id,
      role,
      retailerId: null,
      restaurantName: null,
      representativeName: null,
      contactPhone: (profile?.phone as string | undefined) ?? null,
      deliveryAddress: null,
      isLinked: false,
      creditLimit: 0,
      allowedPaymentMethods: [],
    };
  }

  let isLinked = false;
  let creditLimit = 0;
  let allowedPaymentMethods: string[] = [];

  if (wholesalerId) {
    const { data: relation } = await supabase
      .from("wholesaler_retailers")
      .select("status, credit_limit, allowed_payment_methods")
      .eq("wholesaler_id", wholesalerId)
      .eq("retailer_id", retailer.id as string)
      .maybeSingle();

    isLinked = relation?.status === "active";
    creditLimit = isLinked ? Number(relation?.credit_limit ?? 0) : 0;
    allowedPaymentMethods = isLinked ? ((relation?.allowed_payment_methods as string[] | null) ?? []) : [];
  }

  return {
    userId: user.id,
    role,
    retailerId: retailer.id as string,
    restaurantName: (retailer.restaurant_name as string | null) ?? null,
    representativeName: (retailer.representative_name as string | null) ?? null,
    contactPhone: (profile?.phone as string | undefined) ?? null,
    deliveryAddress:
      [retailer.delivery_address, retailer.delivery_address_detail].filter(Boolean).join(", ") ||
      null,
    isLinked,
    creditLimit,
    allowedPaymentMethods,
  };
}

/**
 * 발주/취소 요청 전용 신원 검증.
 *
 * shop_token → 공급사 → 활성 거래 관계 → retailer_id 를 서버에서 모두 재확인한다.
 * 클라이언트가 보내는 값은 shop_token(URL과 동일)뿐이고, retailer_id/wholesaler_id 는
 * 언제나 auth.uid() 에서 도출한다. 실패 시 사용자 안내 문구를 담아 throw 한다.
 */
export async function requireLinkedBuyer(
  supabase: SupabaseServerClient,
  shopToken: string
): Promise<LinkedBuyer> {
  if (!isValidShopToken(shopToken)) {
    throw new BuyerAuthError(
      "invalid_shop",
      "올바른 미니샵 주소가 아닙니다. 공급사에서 받은 알림톡 링크로 다시 접속해주세요."
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new BuyerAuthError(
      "auth_required",
      "카카오 로그인이 필요합니다. 미니샵에서 [카카오로 3초 시작하기]를 눌러 인증해주세요."
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, phone")
    .eq("id", user.id)
    .maybeSingle();

  const role = (profile?.role as UserRole | undefined) ?? null;

  if (role === "wholesaler" || role === "super_admin") {
    throw new BuyerAuthError(
      "not_a_buyer",
      "공급사/관리자 계정으로는 발주할 수 없습니다. 고객(소매) 카카오 계정으로 로그인해주세요."
    );
  }

  const { data: retailer } = await supabase
    .from("retailers")
    .select("id, restaurant_name, delivery_address, delivery_address_detail")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (!retailer) {
    throw new BuyerAuthError(
      "profile_missing",
      "거래처 정보가 아직 등록되지 않았습니다. 알림톡 링크로 다시 접속해 단골 등록을 완료해주세요."
    );
  }

  // shop_token → 공급사. 활성 거래 관계가 없으면 RLS 가 이 조회부터 막는다.
  const { data: wholesaler } = await supabase
    .from("wholesalers")
    .select("id, profile_id, business_name, status")
    .eq("shop_token", shopToken)
    .maybeSingle();

  if (!wholesaler || wholesaler.status !== "active") {
    throw new BuyerAuthError(
      "invalid_shop",
      "초대 링크가 만료되었거나 공급사와의 거래 관계가 확인되지 않습니다. 알림톡 링크로 다시 접속해주세요."
    );
  }

  const { data: relation } = await supabase
    .from("wholesaler_retailers")
    .select("id, status, credit_limit, outstanding_balance, allowed_payment_methods")
    .eq("wholesaler_id", wholesaler.id as string)
    .eq("retailer_id", retailer.id as string)
    .maybeSingle();

  if (relation?.status !== "active") {
    throw new BuyerAuthError(
      "not_linked",
      "이 공급사와의 거래 관계가 활성 상태가 아닙니다. 알림톡 링크로 다시 접속하거나 공급사에 문의해주세요."
    );
  }

  return {
    userId: user.id,
    retailerId: retailer.id as string,
    restaurantName: (retailer.restaurant_name as string | null) ?? "고객(소매)",
    contactPhone: (profile?.phone as string | undefined) ?? null,
    deliveryAddress:
      [retailer.delivery_address, retailer.delivery_address_detail].filter(Boolean).join(", ") ||
      null,
    wholesalerId: wholesaler.id as string,
    wholesalerName: wholesaler.business_name as string,
    wholesalerProfileId: wholesaler.profile_id as string,
    relationshipId: relation.id as string,
    creditLimit: Number(relation.credit_limit ?? 0),
    outstandingBalance: Number(relation.outstanding_balance ?? 0),
    allowedPaymentMethods: (relation.allowed_payment_methods as string[] | null) ?? [],
  };
}

/**
 * 초대 링크 클레임 — auth.uid() ↔ retailer_id 매핑 확정.
 * 카카오 로그인 직후(콜백) 및 미연결 상태에서 수동 재시도할 때 호출한다.
 */
export interface ClaimShopAccessResult {
  retailerId: string;
  wholesalerId: string;
  businessName: string;
  isLinked: boolean;
}

const CLAIM_ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: "카카오 로그인이 필요합니다. 다시 시도해주세요.",
  INVALID_SHOP_TOKEN: "유효하지 않거나 중지된 공급사 링크입니다. 공급사에 문의해주세요.",
  NOT_A_BUYER_ACCOUNT:
    "공급사/관리자 계정으로는 고객(소매) 미니샵을 이용할 수 없습니다. 고객(소매) 카카오 계정으로 로그인해주세요.",
};

export async function claimShopAccess(shopToken: string): Promise<ClaimShopAccessResult> {
  if (!isValidShopToken(shopToken)) {
    throw new BuyerAuthError("invalid_shop", "올바른 미니샵 주소가 아닙니다.");
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("claim_shop_access", { p_shop_token: shopToken });

  if (error) {
    const matched = Object.keys(CLAIM_ERROR_MESSAGES).find((code) =>
      error.message.includes(code)
    );

    throw new BuyerAuthError(
      matched === "AUTH_REQUIRED" ? "auth_required" : "invalid_shop",
      matched
        ? CLAIM_ERROR_MESSAGES[matched]
        : "단골 등록에 실패했습니다. 잠시 후 다시 시도해주세요."
    );
  }

  const row = data as {
    retailer_id: string;
    wholesaler_id: string;
    business_name: string;
    is_linked: boolean;
  } | null;

  if (!row) {
    throw new BuyerAuthError("invalid_shop", "단골 등록 결과를 확인할 수 없습니다. 다시 시도해주세요.");
  }

  return {
    retailerId: row.retailer_id,
    wholesalerId: row.wholesaler_id,
    businessName: row.business_name,
    isLinked: row.is_linked,
  };
}

// ====================================================================
// 동의 게이트 재확인 (cart/checkout/orders 등 하위 경로)
// ====================================================================

/**
 * 하위 경로 진입 시 동의 게이트 재확인.
 *
 * 루트(/shop/<token>)는 로그인 직후 profiles.terms_agreed_at이 비어 있으면
 * 카탈로그 대신 동의 화면을 보여준다(app/shop/[shop_token]/page.tsx). 하지만
 * 동의를 건너뛰고 cart/checkout/orders를 직접 북마크·재방문하면 그 게이트를
 * 안 거치고 들어올 수 있었다. 이 함수를 하위 페이지 최상단에서 호출해 같은
 * 조건이면 루트로 되돌려보낸다(거기서 다시 동의 화면이 뜬다).
 *
 * 미로그인 사용자는 건드리지 않는다 — 하위 페이지들은 원래도 로그인을
 * 강제하지 않고 guest 카탈로그로 대체해왔다(이 함수의 책임 범위 밖).
 */
export async function requireBuyerConsent(shopToken: string): Promise<void> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, terms_agreed_at")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role === "retailer" && !profile.terms_agreed_at) {
    redirect(`/shop/${shopToken}`);
  }
}
