/**
 * service_role Supabase 클라이언트 생성.
 *
 * `grant_platform_admin` / `revoke_platform_admin` RPC는 anon/authenticated에서
 * REVOKE되어 service_role에만 EXECUTE가 있다(마이그레이션
 * 20260916000000_platform_admin_allowlist.sql 8번 섹션). 브라우저 세션이 명단을
 * 직접 편집할 수 있으면 can_grant 등급 분리가 무의미해지기 때문이다.
 *
 * lib/auth/super-admin-bootstrap.ts의 createAdminClient()와 로직이 같다.
 * 기존 파일을 건드리지 않기 위해 별도 모듈로 분리했다 — 두 곳 모두 이
 * 헬퍼로 옮기는 리팩터링은 별도 커밋으로 다룰 것.
 *
 * 서버 전용 모듈(SUPABASE_SERVICE_ROLE_KEY 참조). 클라이언트 번들에 포함되면 안 된다.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * service_role 클라이언트. 키가 없거나 .env.example 자리표시자면 null을 반환한다.
 */
export function createServiceRoleClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey || serviceRoleKey.includes("your-supabase")) {
    return null;
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
