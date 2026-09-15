/**
 * 슈퍼관리자 셀프 부트스트랩 — SUPER_ADMIN_EMAIL 계정을 DB 관리자로 승격한다.
 *
 * 흐름:
 *   카카오 로그인 → /auth/callback 에서 세션 확립
 *     → 세션 이메일이 SUPER_ADMIN_EMAIL 과 일치하면
 *     → service_role 로 bootstrap_super_admin(uid, email) 호출
 *     → profiles.role = 'super_admin' 확정 (UUID 결속은 DB가 auth.users 로 재확인)
 *   이후 /admin 접근 허용은 환경변수가 아니라 이 DB 값으로만 판정한다.
 *
 * service_role 키를 쓰는 이유:
 *   승격 함수는 anon/authenticated 에서 REVOKE 되어 있다. 브라우저 세션이
 *   자기 자신을 관리자로 만드는 RPC 를 호출할 수 있으면 환경변수 허용 목록이
 *   방어선 역할을 못 하기 때문이다. 또한 profiles 의 자기 승격 차단 트리거는
 *   service_role 에도 그대로 걸리므로, 우회는 SECURITY DEFINER 함수 내부의
 *   전용 세션 플래그로만 열린다.
 *
 * 서버 전용 모듈(next/headers 의존). Edge 런타임에서 import 하지 말 것.
 */

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { getSuperAdminEmail } from "@/lib/auth/super-admin";

export type SuperAdminBootstrapStatus =
  /** SUPER_ADMIN_EMAIL 미설정 — 부트스트랩 자체를 하지 않는다 */
  | "disabled"
  /** Supabase 환경변수 미설정 (데모 모드) */
  | "unconfigured"
  /** 로그인 세션 없음 */
  | "anonymous"
  /** 허용 이메일이 아닌 계정 (정상 경로 — 대부분의 로그인이 여기다) */
  | "not_eligible"
  /** 이미 DB 슈퍼관리자 (재로그인) */
  | "already_admin"
  /** 이번 호출에서 승격됨 */
  | "promoted"
  /** 승격 시도가 실패함 (키 누락 / RPC 오류) */
  | "failed";

export interface SuperAdminBootstrapResult {
  status: SuperAdminBootstrapStatus;
  /**
   * DB(profiles.role) 기준 슈퍼관리자 여부.
   * 화면/라우트 접근 판정에 쓸 수 있는 유일한 값이다.
   */
  isSuperAdmin: boolean;
  userId: string | null;
  /** 실패/스킵 사유 (서버 로그용) */
  reason?: string;
  /** 승격 근거 (예: "allowlist" | "env_root" | "not_eligible") — promote_platform_admin RPC 응답 전달용 */
  source?: string | null;
}

function skip(
  status: SuperAdminBootstrapStatus,
  userId: string | null = null,
  reason?: string
): SuperAdminBootstrapResult {
  return { status, isSuperAdmin: false, userId, reason };
}

// 승격 RPC 는 service_role 에게만 EXECUTE 가 있다. 클라이언트 생성 자체는
// lib/supabase/service-role-client.ts 공용 헬퍼를 쓴다.

/**
 * 현재 세션이 허용 이메일이면 슈퍼관리자로 승격한다. (멱등)
 *
 * 로그인 콜백과 /admin 라우트 가드에서 호출한다. 이미 승격된 계정은
 * 쓰기 없이 즉시 반환하므로 매 요청 호출해도 부담이 없다.
 * 실패해도 예외를 던지지 않는다 — 부트스트랩 실패가 로그인 자체를 막아서는 안 된다.
 */
export async function ensureSuperAdminBootstrap(): Promise<SuperAdminBootstrapResult> {
  const allowedEmail = getSuperAdminEmail();

  if (!isSupabaseConfigured()) {
    return skip("unconfigured", null, "Supabase 환경변수가 설정되지 않았습니다 (데모 모드).");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return skip("anonymous");
  }

  // 이미 승격된 계정이면 service_role 왕복을 생략한다.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role === "super_admin") {
    return { status: "already_admin", isSuperAdmin: true, userId: user.id };
  }

  const admin = createServiceRoleClient();

  if (!admin) {
    console.error(
      "[SuperAdmin Bootstrap] SUPABASE_SERVICE_ROLE_KEY가 없어 승격할 수 없습니다."
    );

    return skip(
      "failed",
      user.id,
      "SUPABASE_SERVICE_ROLE_KEY가 설정되지 않아 슈퍼관리자 승격을 수행할 수 없습니다."
    );
  }

  let data: unknown;
  let error: { message: string } | null;

  try {
    ({ data, error } = await admin.rpc("promote_platform_admin", {
      p_user_id: user.id,
      p_bootstrap_email: allowedEmail,
    }));
  } catch (err) {
    // PLATFORM_ADMIN_TARGET_ALREADY_VERIFIED / PLATFORM_ADMIN_USER_NOT_FOUND /
    // PLATFORM_ADMIN_INVALID_INPUT 등 RPC 내부에서 RAISE EXCEPTION 된 경우 여기로 떨어진다.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[SuperAdmin Bootstrap] 승격 RPC 예외:", message);

    return skip("failed", user.id, message);
  }

  if (error) {
    // SUPER_ADMIN_EMAIL 오타나 카카오 계정 변경 시 여기로 떨어진다.
    console.error("[SuperAdmin Bootstrap] 승격 RPC 오류:", error.message);

    return skip("failed", user.id, error.message);
  }

  const row = data as { promoted?: boolean; role?: string; source?: string | null } | null;

  if (row?.promoted) {
    console.info(`[SuperAdmin Bootstrap] 슈퍼관리자 승격 완료: ${user.id}`);

    return {
      status: "promoted",
      isSuperAdmin: true,
      userId: user.id,
      source: row.source ?? null,
    };
  }

  if (row?.role === "super_admin") {
    return {
      status: "already_admin",
      isSuperAdmin: true,
      userId: user.id,
      source: row.source ?? null,
    };
  }

  return {
    status: "not_eligible",
    isSuperAdmin: false,
    userId: user.id,
    source: row?.source ?? null,
  };
}
