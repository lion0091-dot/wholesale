/**
 * "/admin/admins" 진입 가드 — 다른 관리자를 승격/강등할 수 있는 계정(can_grant=true
 * super_admin)만 통과시킨다.
 *
 * can_current_user_grant_admin() RPC 는 platform_admin_allowlist.can_grant 와
 * profiles.role='super_admin' 을 함께 확인하는 SECURITY DEFINER 함수다(DB가 근거).
 * 관리자 권한 부여라는 민감한 기능이므로, 다른 관리자 라우트 가드와 달리 데모 모드
 * 예외를 두지 않고 middleware.ts 와 동일한 fail-closed 원칙을 적용한다: RPC 에러와
 * 명시적 false 를 구분하지 않고 둘 다 차단한다.
 */

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";

/**
 * 현재 세션이 다른 관리자를 승격/강등할 수 있는 계정인지 확인한다.
 * 통과하지 못하면 redirect() 로 로그인 페이지로 보낸다(반환하지 않음).
 * 통과하면 호출부가 다시 getUser()를 부르지 않도록 세션 사용자 id를 돌려준다.
 */
export async function requireAdminGranter(): Promise<string> {
  if (!isSupabaseConfigured()) {
    redirect("/login?next=/admin/admins");
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/admin/admins");
  }

  let data: unknown;
  let error: { message: string } | null;

  try {
    ({ data, error } = await supabase.rpc("can_current_user_grant_admin"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[AdminGranter] can_current_user_grant_admin RPC 예외:", message);

    redirect("/login?next=/admin/admins");
  }

  if (error) {
    console.error("[AdminGranter] can_current_user_grant_admin RPC 오류:", error.message);

    redirect("/login?next=/admin/admins");
  }

  if (!data) {
    redirect("/login?next=/admin/admins");
  }

  return user.id;
}
