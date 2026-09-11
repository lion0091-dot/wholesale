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
 * Role별 기본 랜딩 경로.
 * 단일 계정은 하나의 Role만 가지므로(RBAC 분리 원칙) 교차 진입 경로를 만들지 않는다.
 */
export function getLandingPathForRole(role: UserRole | null | undefined): string {
  switch (role) {
    case "super_admin":
      return "/admin/wholesalers";
    case "wholesaler":
      return "/wholesaler/products";
    case "retailer":
      return "/";
    default:
      return "/";
  }
}
