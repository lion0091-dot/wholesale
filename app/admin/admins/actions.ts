"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import type { UserRole } from "@/types/database";

const ADMIN_PATH = "/admin/admins";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * 승격 후보 검색 결과 행. is_verified=true 계정은 쿼리 단계에서 이미 제외되므로
 * 이 타입에는 포함하지 않는다(항상 false인 필드를 화면까지 들고 가지 않기 위함).
 */
export interface AdminCandidate {
  id: string;
  name: string;
  phone: string;
  role: UserRole;
}

/** 한 번에 보여줄 후보 수. 전체 회원을 나열하지 않고 검색 결과만 좁혀서 보여준다. */
const CANDIDATE_SEARCH_LIMIT = 20;
/** 너무 짧은 검색어로 사실상 전체 스캔이 되는 것을 막는다. */
const CANDIDATE_SEARCH_MIN_LENGTH = 2;

interface GrantGuardOk {
  actorId: string;
}

interface GrantGuardFail {
  error: string;
}

/**
 * can_current_user_grant_admin() RPC로 행위자를 검증한다.
 *
 * 관리자 권한 부여라는 민감한 기능이라 lib/auth/admin-granter.ts의 페이지 가드와
 * 동일하게 데모 모드 예외를 두지 않는다(suppliers/actions.ts의 assertSuperAdmin과
 * 다른 지점 — 그쪽은 데모 모드를 통과시킨다). 또한 이 액션은 Server Action이라
 * 페이지 가드(requireAdminGranter)를 거치지 않고 직접 호출될 수 있으므로,
 * 에러와 명시적 false를 구분하지 않고 둘 다 차단하는 fail-closed 원칙을 그대로
 * 적용한다.
 */
async function assertCanGrantAdmin(): Promise<GrantGuardOk | GrantGuardFail> {
  if (!isSupabaseConfigured()) {
    return { error: "데모 모드에서는 사용할 수 없습니다." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "로그인이 필요합니다." };
  }

  let data: unknown;
  let error: { message: string } | null;

  try {
    ({ data, error } = await supabase.rpc("can_current_user_grant_admin"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[AdminActions] can_current_user_grant_admin RPC 예외:", message);

    return { error: "권한 확인 중 오류가 발생했습니다." };
  }

  if (error) {
    console.error("[AdminActions] can_current_user_grant_admin RPC 오류:", error.message);

    return { error: "권한 확인 중 오류가 발생했습니다." };
  }

  if (!data) {
    return { error: "관리자 명단을 편집할 권한이 없습니다." };
  }

  return { actorId: user.id };
}

/**
 * 이름/전화번호로 승격 후보(profiles)를 검색한다.
 *
 * 이메일 사전등록을 지원하지 않으므로(CLAUDE.md 잠긴 설계 결정) 후보는 항상
 * "이미 로그인한 계정"이고, profiles 검색이 유일한 탐색 경로다. RLS가
 * super_admin에게만 profiles 전체 조회를 허용하므로 이 함수 자체도 방어선
 * 역할을 하지만, can_grant 없는 관리자(거버넌스 업무만 하는 일반 관리자)는
 * super_admin이라도 명단 편집 화면에 접근하면 안 되므로 assertCanGrantAdmin으로
 * 한 번 더 좁힌다.
 *
 * is_verified=true 계정(행정 승인이 끝난 정회원 공급사)은 쿼리 조건에서 완전히
 * 제외한다 — 검색 결과에 아예 나타나지 않는다. promote_platform_admin의
 * PLATFORM_ADMIN_TARGET_ALREADY_VERIFIED 가드가 최종 방어선이지만, 애초에
 * 승격할 수 없는 계정을 후보로 보여주지 않는 편을 택했다.
 *
 * wholesalers row가 있는 계정(= 온보딩을 완료해 실제 입점 심사 대기 중인 신청자,
 * /admin/suppliers 승인 대기 목록에 뜨는 그 계정)도 검색 결과에서 제외한다.
 * "승인대기"와 "후보대기"가 같은 계정을 동시에 보여주면 실제 입점 신청자를
 * 실수로 관리자로 승격시킬 수 있다 — signup_channel='staff' 가드
 * (complete_supplier_signup, 20260921000000)가 스태프 계정이 저쪽으로 넘어가는
 * 걸 막는 반대 방향 안전장치라면, 이 필터는 이쪽에서 막는 안전장치다.
 */
export async function searchAdminCandidatesAction(
  query: string
): Promise<ActionResult<AdminCandidate[]>> {
  const guard = await assertCanGrantAdmin();

  if ("error" in guard) {
    return { success: false, error: guard.error };
  }

  const trimmed = query.trim();

  if (trimmed.length < CANDIDATE_SEARCH_MIN_LENGTH) {
    return { success: true, data: [] };
  }

  const supabase = await createClient();
  // ILIKE 와일드카드 문자를 리터럴로 취급 — 검색어에 %/_ 가 있어도 패턴처럼 동작하지 않게.
  const escaped = trimmed.replace(/[%_\\]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  const selectColumns = "id, name, phone, role";

  const [{ data: byName, error: nameError }, { data: byPhone, error: phoneError }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select(selectColumns)
        .neq("role", "super_admin")
        .eq("is_verified", false)
        .ilike("name", pattern)
        .limit(CANDIDATE_SEARCH_LIMIT),
      supabase
        .from("profiles")
        .select(selectColumns)
        .neq("role", "super_admin")
        .eq("is_verified", false)
        .ilike("phone", pattern)
        .limit(CANDIDATE_SEARCH_LIMIT),
    ]);

  if (nameError || phoneError) {
    console.error(
      "[AdminActions] 후보 검색 오류:",
      nameError?.message ?? phoneError?.message
    );

    return { success: false, error: "후보 검색에 실패했습니다." };
  }

  const merged = new Map<string, AdminCandidate>();

  for (const row of [...(byName ?? []), ...(byPhone ?? [])] as AdminCandidate[]) {
    merged.set(row.id, row);
  }

  // wholesalers row가 있으면 실제 입점 신청자(승인 대기 목록에 이미 뜨는 계정)이므로
  // 관리자 후보에서 제외한다.
  if (merged.size > 0) {
    const { data: wholesalerRows, error: wholesalerError } = await supabase
      .from("wholesalers")
      .select("profile_id")
      .in("profile_id", Array.from(merged.keys()));

    if (wholesalerError) {
      console.error("[AdminActions] 후보 필터링(wholesalers 조회) 오류:", wholesalerError.message);

      return { success: false, error: "후보 검색에 실패했습니다." };
    }

    for (const row of (wholesalerRows ?? []) as { profile_id: string }[]) {
      merged.delete(row.profile_id);
    }
  }

  return { success: true, data: Array.from(merged.values()).slice(0, CANDIDATE_SEARCH_LIMIT) };
}

export interface PromoteAdminInput {
  userId: string;
  /** 관리자 명단 편집 권한까지 줄지 여부. 기본값은 거버넌스 업무만(false). */
  canGrant: boolean;
  note?: string;
}

/**
 * grant_platform_admin RPC의 RAISE EXCEPTION 코드를 사용자 메시지로 매핑한다.
 * 알 수 없는 코드는 뭉뚱그린 실패 메시지로 처리한다(서버 내부 오류 문자열을
 * 그대로 노출하지 않기 위함).
 */
const GRANT_ERROR_MESSAGES: Record<string, string> = {
  PLATFORM_ADMIN_INVALID_INPUT: "요청 값이 올바르지 않습니다.",
  PLATFORM_ADMIN_GRANT_FORBIDDEN: "관리자 명단을 편집할 권한이 없습니다.",
  PLATFORM_ADMIN_USER_NOT_FOUND:
    "해당 계정을 찾을 수 없습니다. 최소 한 번은 로그인한 계정만 등재할 수 있습니다.",
  PLATFORM_ADMIN_TARGET_ALREADY_VERIFIED: "행정 승인이 끝난 계정은 관리자로 승격할 수 없습니다.",
};

function resolveGrantErrorMessage(rawMessage: string): string {
  const matchedCode = Object.keys(GRANT_ERROR_MESSAGES).find((code) => rawMessage.includes(code));

  return matchedCode ? GRANT_ERROR_MESSAGES[matchedCode] : "관리자 승격에 실패했습니다.";
}

/**
 * 대상 계정을 관리자 명단에 등재하고 승격한다(grant_platform_admin, 한 트랜잭션).
 *
 * grant_platform_admin은 service_role 전용이라 createServiceRoleClient()로 호출한다.
 * 행위자(p_actor_id)는 세션에서 얻은 값을 그대로 넘기고, 실제 can_grant 검증은
 * assertCanGrantAdmin(세션 클라이언트)과 RPC 내부(6-1) 양쪽에서 이중으로 한다 —
 * service_role 클라이언트는 RLS를 우회하므로 앱 레이어의 사전 검증이 유일한
 * 방어선처럼 보일 수 있지만, RPC 자체도 p_actor_id의 can_grant를 재확인한다.
 */
export async function promoteAdminAction({
  userId,
  canGrant,
  note,
}: PromoteAdminInput): Promise<ActionResult> {
  const guard = await assertCanGrantAdmin();

  if ("error" in guard) {
    return { success: false, error: guard.error };
  }

  if (!userId) {
    return { success: false, error: "대상 계정이 지정되지 않았습니다." };
  }

  const admin = createServiceRoleClient();

  if (!admin) {
    console.error("[AdminActions] SUPABASE_SERVICE_ROLE_KEY가 없어 승격할 수 없습니다.");

    return { success: false, error: "서버 설정 오류로 승격할 수 없습니다." };
  }

  let data: unknown;
  let error: { message: string } | null;

  try {
    ({ data, error } = await admin.rpc("grant_platform_admin", {
      p_user_id: userId,
      p_actor_id: guard.actorId,
      p_can_grant: canGrant,
      p_note: note?.trim() || null,
    }));
  } catch (err) {
    // PLATFORM_ADMIN_TARGET_ALREADY_VERIFIED 등 RPC 내부 RAISE EXCEPTION은 여기로 떨어진다.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[AdminActions] grant_platform_admin RPC 예외:", message);

    return { success: false, error: resolveGrantErrorMessage(message) };
  }

  if (error) {
    console.error("[AdminActions] grant_platform_admin RPC 오류:", error.message);

    return { success: false, error: resolveGrantErrorMessage(error.message) };
  }

  void data; // 응답 payload(JSONB)는 현재 화면에서 쓰지 않는다 — revalidatePath로 목록을 다시 조회한다.

  revalidatePath(ADMIN_PATH);

  return { success: true };
}

/**
 * revoke_platform_admin RPC의 RAISE EXCEPTION 코드를 사용자 메시지로 매핑한다.
 */
const REVOKE_ERROR_MESSAGES: Record<string, string> = {
  PLATFORM_ADMIN_INVALID_INPUT: "요청 값이 올바르지 않습니다.",
  PLATFORM_ADMIN_SELF_REVOKE: "자기 자신의 관리자 권한은 회수할 수 없습니다.",
  PLATFORM_ADMIN_GRANT_FORBIDDEN: "관리자 명단을 편집할 권한이 없습니다.",
  // 마지막 남은 can_grant 관리자 — 회수하면 아무도 명단을 편집할 수 없게 된다.
  // (2026-09-20 마이그레이션 수정으로 추가된 DB 가드에 대응)
  PLATFORM_ADMIN_LAST_GRANTER:
    "마지막 남은 관리자 편집 권한 보유자입니다. 다른 계정에 편집 권한을 먼저 부여한 뒤 회수해주세요.",
  PLATFORM_ADMIN_NOT_ALLOWLISTED: "해당 계정은 이미 관리자 명단에 없습니다.",
};

function resolveRevokeErrorMessage(rawMessage: string): string {
  const matchedCode = Object.keys(REVOKE_ERROR_MESSAGES).find((code) => rawMessage.includes(code));

  return matchedCode ? REVOKE_ERROR_MESSAGES[matchedCode] : "관리자 회수에 실패했습니다.";
}

/**
 * 대상 계정의 관리자 명단 항목을 무효화하고 profiles.role을 강등한다
 * (revoke_platform_admin, 한 트랜잭션).
 *
 * 자기 자신 회수는 RPC(7-1)가 PLATFORM_ADMIN_SELF_REVOKE로 막지만, 불필요한
 * service_role 왕복과 감사 로그를 남기지 않기 위해 앱 레이어에서도 먼저
 * 막는다 — 마지막 can_grant 관리자 락아웃 가드(7번 섹션 주석)는 앱에서 따로
 * 흉내내지 않는다: 회수자는 항상 can_grant 보유자이고 자기 자신은 회수할 수
 * 없으므로, 어떤 회수가 성공하든 회수자 자신이 활성 편집자로 남는다는 것이
 * DB 쪽 설계이기 때문이다(RPC 주석과 동일 근거).
 */
export async function revokeAdminAction(userId: string): Promise<ActionResult> {
  const guard = await assertCanGrantAdmin();

  if ("error" in guard) {
    return { success: false, error: guard.error };
  }

  if (!userId) {
    return { success: false, error: "대상 계정이 지정되지 않았습니다." };
  }

  if (userId === guard.actorId) {
    return { success: false, error: REVOKE_ERROR_MESSAGES.PLATFORM_ADMIN_SELF_REVOKE };
  }

  const admin = createServiceRoleClient();

  if (!admin) {
    console.error("[AdminActions] SUPABASE_SERVICE_ROLE_KEY가 없어 회수할 수 없습니다.");

    return { success: false, error: "서버 설정 오류로 회수할 수 없습니다." };
  }

  let data: unknown;
  let error: { message: string } | null;

  try {
    ({ data, error } = await admin.rpc("revoke_platform_admin", {
      p_user_id: userId,
      p_actor_id: guard.actorId,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[AdminActions] revoke_platform_admin RPC 예외:", message);

    return { success: false, error: resolveRevokeErrorMessage(message) };
  }

  if (error) {
    console.error("[AdminActions] revoke_platform_admin RPC 오류:", error.message);

    return { success: false, error: resolveRevokeErrorMessage(error.message) };
  }

  void data;

  revalidatePath(ADMIN_PATH);

  return { success: true };
}
