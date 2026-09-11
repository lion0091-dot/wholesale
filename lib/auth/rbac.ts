import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types/database";

/** 조직 내 직원 역할 (DB: public.organization_role) */
export type OrgRole = "owner" | "manager" | "staff";

/** 역할 서열 — 숫자가 클수록 상위 권한 */
const ROLE_RANK: Record<OrgRole, number> = {
  staff: 1,
  manager: 2,
  owner: 3,
};

export interface Organization {
  id: string;
  wholesaler_id: string | null;
  name: string;
  business_number: string;
  representative_name: string | null;
  subscription_tier: "lite" | "pro" | "enterprise";
  created_at: string;
  updated_at: string;
}

export interface OrganizationStaff {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrgRole;
  invited_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrgStaffContext {
  userId: string;
  email: string | null;
  /** profiles.role — 플랫폼 레벨 역할 */
  platformRole: UserRole | null;
  /** 소속 조직 없으면 null (예: 슈퍼관리자, 조직 미생성 도매) */
  organizationId: string | null;
  orgRole: OrgRole | null;
  isSuperAdmin: boolean;
}

/** RBAC 검증 실패 — Server Action에서 catch하여 사용자 메시지로 변환한다. */
export class RbacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RbacError";
  }
}

/**
 * 현재 세션의 플랫폼 역할 + 조직 소속/역할을 한 번에 조회한다.
 * 미인증이면 null.
 */
export async function getOrgStaffContext(): Promise<OrgStaffContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const [{ data: profile }, { data: staff }] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    supabase
      .from("organization_staff")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  const platformRole = (profile?.role as UserRole | undefined) ?? null;

  return {
    userId: user.id,
    email: user.email ?? null,
    platformRole,
    organizationId: (staff?.organization_id as string | undefined) ?? null,
    orgRole: (staff?.role as OrgRole | undefined) ?? null,
    isSuperAdmin: platformRole === "super_admin",
  };
}

/** 인증 필수. 미인증이면 RbacError. */
export async function requireSession(): Promise<OrgStaffContext> {
  const context = await getOrgStaffContext();

  if (!context) {
    throw new RbacError("로그인이 필요합니다.");
  }

  return context;
}

/**
 * 플랫폼 슈퍼관리자 전용 작업 검증.
 * 공급사 입점 승인/구독 제어처럼 조직 경계를 넘는 거버넌스 액션에 사용한다.
 */
export async function requireSuperAdmin(): Promise<OrgStaffContext> {
  const context = await requireSession();

  if (!context.isSuperAdmin) {
    throw new RbacError("플랫폼 슈퍼관리자만 접근할 수 있습니다.");
  }

  return context;
}

/** 예외 없이 boolean으로만 확인 (Server Component 라우트 가드용) */
export async function isSuperAdminSession(): Promise<boolean> {
  const context = await getOrgStaffContext();

  return context?.isSuperAdmin ?? false;
}

/** 조직 소속 필수. 소속이 없으면 RbacError. */
export async function requireOrgStaffContext(): Promise<
  OrgStaffContext & { organizationId: string; orgRole: OrgRole }
> {
  const context = await requireSession();

  if (!context.organizationId || !context.orgRole) {
    throw new RbacError("소속된 공급사 조직이 없습니다. 조직을 먼저 생성해주세요.");
  }

  return { ...context, organizationId: context.organizationId, orgRole: context.orgRole };
}

/**
 * 허용 역할 목록을 검증한다. 슈퍼관리자는 통과(감독 권한).
 * 슈퍼관리자가 조직에 소속되지 않은 경우 organizationId는 null일 수 있으므로,
 * 조직 ID가 반드시 필요한 작업에는 requireOrgRole의 반환값을 확인해야 한다.
 */
export async function requireOrgRole(
  allowed: OrgRole[]
): Promise<OrgStaffContext> {
  const context = await requireSession();

  if (context.isSuperAdmin) {
    return context;
  }

  if (!context.organizationId || !context.orgRole) {
    throw new RbacError("소속된 공급사 조직이 없습니다.");
  }

  if (!allowed.includes(context.orgRole)) {
    throw new RbacError("이 작업을 수행할 권한이 없습니다.");
  }

  return context;
}

/** 최소 역할 이상인지 검증 (staff < manager < owner) */
export async function requireMinOrgRole(minimum: OrgRole): Promise<OrgStaffContext> {
  const context = await requireSession();

  if (context.isSuperAdmin) {
    return context;
  }

  if (!context.orgRole || ROLE_RANK[context.orgRole] < ROLE_RANK[minimum]) {
    throw new RbacError("이 작업을 수행할 권한이 없습니다.");
  }

  return context;
}

/** 예외 없이 boolean으로만 확인 (UI 조건부 렌더링용) */
export async function hasOrgRole(allowed: OrgRole[]): Promise<boolean> {
  const context = await getOrgStaffContext();

  if (!context) return false;
  if (context.isSuperAdmin) return true;

  return context.orgRole !== null && allowed.includes(context.orgRole);
}

/** a가 b보다 상위 역할인지 */
export function isHigherRole(a: OrgRole, b: OrgRole): boolean {
  return ROLE_RANK[a] > ROLE_RANK[b];
}

/** 초대/역할변경 시, 행위자가 대상 역할을 부여할 수 있는지 검증 */
export function canAssignRole(actorRole: OrgRole, targetRole: OrgRole): boolean {
  // owner만 owner/manager를 지정할 수 있고, manager는 staff까지만 지정 가능
  if (actorRole === "owner") return true;
  if (actorRole === "manager") return targetRole === "staff";
  return false;
}
