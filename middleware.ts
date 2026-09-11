import { NextResponse, type NextRequest } from "next/server";
import { updateSession, withSessionCookies } from "@/lib/supabase/middleware";
import {
  CUSTOMER_SESSION_COOKIE,
  verifyCustomerSessionCookie,
} from "@/lib/auth/customer-token-edge";
import { isDevOrgBypassEnabled } from "@/lib/auth/dev-mode";

/** 공급사 백오피스 — 로그인 + 조직 소속(organization_staff) 필수 */
const SUPPLIER_PREFIXES = ["/dashboard"];

/** 플랫폼 거버넌스 콘솔 — profiles.role === "super_admin" 필수 */
const ADMIN_PREFIXES = ["/admin"];

/**
 * 조직 미소속 사용자를 보낼 온보딩 경로.
 * 백오피스 레이아웃(사이드바/조직 헤더) 밖의 독립 라우트여야 한다.
 */
const ORG_ONBOARDING_PATH = "/onboarding";

const LOGIN_PATH = "/login";

/** /shop/<token> 에서 토큰 추출 */
function extractShopToken(pathname: string): string | null {
  const match = pathname.match(/^\/shop\/([^/]+)/);

  return match ? decodeURIComponent(match[1]) : null;
}

function redirectTo(request: NextRequest, pathname: string, params?: Record<string, string>) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";

  if (params) {
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  }

  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { response, user, supabase } = await updateSession(request);

  // ------------------------------------------------------------------
  // 0) 플랫폼 관리자 콘솔 보호 (/admin) — 슈퍼관리자 전용
  // ------------------------------------------------------------------
  const isAdminRoute = ADMIN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (isAdminRoute && supabase) {
    if (!user) {
      return withSessionCookies(
        redirectTo(request, LOGIN_PATH, { next: pathname }),
        response
      );
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profile?.role !== "super_admin") {
      // 권한 없는 인증 사용자는 관리자 콘솔의 존재를 노출하지 않고 홈으로 돌려보낸다.
      return withSessionCookies(redirectTo(request, "/"), response);
    }

    return response;
  }

  // ------------------------------------------------------------------
  // 1) 공급사 백오피스 보호 (/dashboard)
  // ------------------------------------------------------------------
  const isSupplierRoute = SUPPLIER_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  // supabase가 null이면 환경변수 미설정(데모 모드)이므로 가드를 적용하지 않는다.
  if (isSupplierRoute && supabase) {
    if (!user) {
      return withSessionCookies(
        redirectTo(request, LOGIN_PATH, { next: pathname }),
        response
      );
    }

    // 조직 세션 바인딩 검증: organization_staff 소속이 없으면 온보딩으로 유도.
    // 온보딩(/onboarding)은 /dashboard 밖이므로 리다이렉트 루프가 생기지 않는다.
    const { data: staff } = await supabase
      .from("organization_staff")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!staff) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();

      // 슈퍼관리자는 조직 소속 없이도 백오피스 접근 허용
      if (profile?.role !== "super_admin") {
        // 개발/테스트 환경에서는 온보딩으로 튕기지 않고 통과시킨다.
        // 기본 테스트 조직 연결은 Node 런타임(로그인 액션 / 온보딩 화면)에서 수행한다.
        if (!isDevOrgBypassEnabled()) {
          return withSessionCookies(redirectTo(request, ORG_ONBOARDING_PATH), response);
        }

        response.headers.set("x-dev-org-bypass", "1");
      }
    } else {
      // 다운스트림(Server Component)에서 재조회 없이 사용할 수 있도록 전달
      response.headers.set("x-organization-id", String(staff.organization_id));
      response.headers.set("x-organization-role", String(staff.role));
    }

    return response;
  }

  // ------------------------------------------------------------------
  // 2) 고객 미니샵 토큰 세션 검증 (/shop/<token>)
  // ------------------------------------------------------------------
  const shopToken = extractShopToken(pathname);

  if (shopToken) {
    const raw = request.cookies.get(CUSTOMER_SESSION_COOKIE)?.value;
    const session = await verifyCustomerSessionCookie(raw);

    if (session && session.shopToken === shopToken) {
      // 유효한 세션 — 조직/고객사 바인딩 정보를 페이지로 전달
      response.headers.set("x-customer-session", "valid");
      response.headers.set("x-shop-wholesaler-id", session.wholesalerId);

      if (session.organizationId) {
        response.headers.set("x-shop-organization-id", session.organizationId);
      }

      if (session.retailerId) {
        response.headers.set("x-shop-retailer-id", session.retailerId);
      }

      return response;
    }

    // 세션이 없거나 다른 공급사 토큰 → 스테일 쿠키 제거 후 재바인딩 요청 신호 전달.
    // 실제 토큰 DB 검증과 쿠키 발급은 Node 런타임의 enterShopWithToken() 서버 액션이 수행한다.
    if (raw) {
      response.cookies.delete(CUSTOMER_SESSION_COOKIE);
    }

    response.headers.set("x-customer-session", session ? "mismatch" : "required");
    response.headers.set("x-shop-token", shopToken);

    return response;
  }

  return response;
}

export const config = {
  // 정적 자산/이미지 최적화 요청은 세션 갱신 대상에서 제외
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
