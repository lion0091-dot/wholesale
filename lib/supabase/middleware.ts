import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";

type CookiesToSet = Array<{ name: string; value: string; options: CookieOptions }>;

export interface SessionUpdateResult {
  /** 갱신된 쿠키가 실린 응답 (리다이렉트 시 쿠키를 복사해야 한다) */
  response: NextResponse;
  /** 검증된 세션 사용자 (미인증 또는 미설정 환경이면 null) */
  user: User | null;
  /** 미들웨어 스코프 Supabase 클라이언트 (미설정 환경이면 null) */
  supabase: SupabaseClient | null;
}

/**
 * Supabase 환경변수가 실제로 주입되었는지 확인한다.
 * 데모/로컬 환경(placeholder)에서는 불필요한 네트워크 호출을 막기 위해 세션 갱신을 건너뛴다.
 */
export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return Boolean(url && anonKey && !url.includes("placeholder") && !anonKey.includes("placeholder"));
}

/**
 * 모든 요청마다 Supabase Auth 세션(JWT)을 갱신하고, 갱신된 쿠키를 응답에 실어 보낸다.
 * Next.js Server Component는 쿠키를 쓸 수 없으므로 세션 갱신은 반드시 미들웨어에서 수행해야 한다.
 */
export async function updateSession(request: NextRequest): Promise<SessionUpdateResult> {
  let response = NextResponse.next({ request });

  if (!isSupabaseConfigured()) {
    return { response, user: null, supabase: null };
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookiesToSet) {
          // 1) 다운스트림(Server Component)에서 최신 쿠키를 읽을 수 있도록 request에 반영
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          // 2) 브라우저에 갱신된 쿠키를 내려주기 위해 response를 재생성
          response = NextResponse.next({ request });

          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // getUser()를 호출해야 만료 직전의 Access Token이 실제로 갱신된다.
  // (getSession()은 쿠키를 그대로 신뢰하므로 미들웨어에서는 사용하지 않는다.)
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, user, supabase };
}

/**
 * 리다이렉트 응답에 세션 갱신 쿠키를 이어붙인다.
 * (쿠키를 옮기지 않으면 갱신된 토큰이 유실되어 무한 리다이렉트가 발생한다.)
 */
export function withSessionCookies(
  target: NextResponse,
  source: NextResponse
): NextResponse {
  source.cookies.getAll().forEach((cookie) => {
    target.cookies.set(cookie);
  });

  return target;
}
