import { NextResponse, type NextRequest } from "next/server";
import { updateSession, withSessionCookies } from "@/lib/supabase/middleware";
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

/** 폐기된 미니샵 서명 쿠키 — 스테일 값이 남아 있으면 제거한다. */
const LEGACY_CUSTOMER_SESSION_COOKIE = "wsale_customer_session";

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
  // 2) 고객 미니샵 (/shop/<token>)
  //
  //    바이어 인증은 Supabase Auth(카카오 OAuth) 세션 하나로 판정한다.
  //    폐기된 서명 쿠키(wsale_customer_session)는 남아 있으면 제거만 하고,
  //    로그인 여부 판정과 [카카오로 3초 시작하기] 게이트는 진입 라우트가 담당한다.
  //    (미들웨어에서 리다이렉트하지 않는 이유: 카카오 인앱 브라우저에서 OAuth
  //     왕복 중 중간 리다이렉트가 끼면 동의 화면이 끊기는 경우가 있다)
  // ------------------------------------------------------------------
  const shopToken = extractShopToken(pathname);

  if (shopToken) {
    if (request.cookies.get(LEGACY_CUSTOMER_SESSION_COOKIE)) {
      response.cookies.delete(LEGACY_CUSTOMER_SESSION_COOKIE);
    }

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
