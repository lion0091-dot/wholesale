import { createClient } from "@/lib/supabase/server";
import type { Profile, UserRole } from "@/types/database";

export interface SessionContext {
  userId: string;
  email: string | null;
  profile: Profile | null;
}

/**
 * 현재 요청의 Supabase Auth 세션을 검증한다.
 * getUser()는 Auth 서버에서 JWT를 재검증하므로 쿠키 위조에 안전하다.
 */
export async function getSessionUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

/**
 * 세션 사용자 + profiles 레코드(단일 Role)를 함께 조회한다.
 * 미인증 상태면 null을 반환한다.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, role, name, phone, created_at, updated_at")
    .eq("id", user.id)
    .maybeSingle();

  return {
    userId: user.id,
    email: user.email ?? null,
    profile: (profile as Profile | null) ?? null,
  };
}

/**
 * `?next=` 목적지 검증. 오픈 리다이렉트를 막기 위해 내부 절대 경로만 허용하고,
 * 로그인 화면으로 되돌아가는 값은 리다이렉트 루프가 되므로 버린다.
 */
export function sanitizeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/")) {
    return null;
  }

  // "//host", "/\host" → 프로토콜 상대 URL(외부 도메인)로 해석될 수 있다.
  if (next.startsWith("//") || next.includes("\\")) {
    return null;
  }

  if (next === "/login" || next.startsWith("/login/") || next.startsWith("/login?")) {
    return null;
  }

  return next;
}

/**
 * Role별 기본 랜딩 경로.
 * 단일 계정은 하나의 Role만 가지므로(RBAC 분리 원칙) 교차 진입 경로를 만들지 않는다.
 */
export function getLandingPathForRole(role: UserRole | null | undefined): string {
  switch (role) {
    case "super_admin":
      return "/admin/suppliers";
    case "wholesaler":
      // 공급사 백오피스는 /dashboard 트리다. (/wholesaler/*는 Phase 1 레거시 화면)
      return "/dashboard";
    case "retailer":
      // 바이어(구매 회원)는 백오피스 계정이 아니며 전용 초대 링크(/shop/<token>)로만 진입한다.
      return "/";
    default:
      // profiles.role이 아직 없는 신규 계정도 백오피스로 보낸다.
      // 조직 미소속이면 미들웨어가 /onboarding으로 유도하므로 가드는 한 곳에만 둔다.
      return "/dashboard";
  }
}
