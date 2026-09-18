"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  RbacError,
  canAssignRole,
  requireOrgRole,
  requireSession,
  type OrgRole,
} from "@/lib/auth/rbac";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

const ORG_ROLES: OrgRole[] = ["owner", "manager", "staff"];
const SUBSCRIPTION_TIERS = ["lite", "pro", "enterprise"] as const;
/** 직원 관리 화면 — 카카오 초대 링크 기반으로 재구축(app/dashboard/team) */
const REVALIDATE_PATH = "/dashboard/team";

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

// ====================================================================
// 1. 조직 생성 (생성자는 자동으로 owner로 등록)
// ====================================================================
export async function createOrganization(
  formData: FormData
): Promise<ActionResult<{ organizationId: string }>> {
  try {
    const context = await requireSession();

    if (context.platformRole !== "wholesaler" && !context.isSuperAdmin) {
      throw new RbacError("도매(공급사) 계정만 조직을 생성할 수 있습니다.");
    }

    if (context.organizationId) {
      throw new RbacError("이미 소속된 조직이 있습니다. 한 계정은 하나의 조직에만 소속됩니다.");
    }

    const name = ((formData.get("name") as string) || "").trim();
    const businessNumber = ((formData.get("business_number") as string) || "").replace(/[^0-9]/g, "");
    const representativeName = ((formData.get("representative_name") as string) || "").trim() || null;
    const tierInput = ((formData.get("subscription_tier") as string) || "pro").trim();

    if (name.length < 2) {
      throw new RbacError("조직(업체)명을 2자 이상 입력해주세요.");
    }

    if (businessNumber.length !== 10) {
      throw new RbacError("사업자등록번호 10자리를 정확히 입력해주세요.");
    }

    const subscriptionTier = (SUBSCRIPTION_TIERS as readonly string[]).includes(tierInput)
      ? tierInput
      : "pro";

    const supabase = await createClient();

    // 기존 Phase 1 wholesalers 레코드가 있으면 1:1로 연결
    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("id")
      .eq("profile_id", context.userId)
      .maybeSingle();

    const { data: organization, error: orgError } = await supabase
      .from("organizations")
      .insert({
        wholesaler_id: wholesaler?.id ?? null,
        name,
        business_number: businessNumber,
        representative_name: representativeName,
        subscription_tier: subscriptionTier,
      })
      .select("id")
      .single();

    if (orgError || !organization) {
      if (orgError?.code === "23505") {
        throw new RbacError("이미 등록된 사업자등록번호입니다.");
      }
      throw new Error(orgError?.message ?? "조직 생성에 실패했습니다.");
    }

    // 부트스트랩: 직원이 없는 조직에 본인을 owner로 등록 (RLS 정책에서 허용)
    const { error: staffError } = await supabase.from("organization_staff").insert({
      organization_id: organization.id,
      user_id: context.userId,
      role: "owner",
    });

    if (staffError) {
      // owner 등록 실패 시 고아 조직이 남지 않도록 롤백
      await supabase.from("organizations").delete().eq("id", organization.id);
      throw new Error(`대표(owner) 등록 실패: ${staffError.message}`);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { organizationId: organization.id } };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 2. 직원 초대 링크 — 카카오 OAuth 전용 구조라 이메일 초대 대신 바이어
//    shop_token과 같은 패턴(토큰 링크 → 카카오 로그인 → 자동 연결)을 쓴다.
//    실제 연결은 claim_organization_staff_invite() RPC(app/auth/callback)가 수행한다.
// ====================================================================
export interface StaffInvite {
  id: string;
  role: OrgRole;
  token: string;
  expiresAt: string;
  revokedAt: string | null;
  usedCount: number;
  createdAt: string;
}

interface StaffInviteRow {
  id: string;
  role: OrgRole;
  token: string;
  expires_at: string;
  revoked_at: string | null;
  used_count: number;
  created_at: string;
}

function toStaffInvite(row: StaffInviteRow): StaffInvite {
  return {
    id: row.id,
    role: row.role,
    token: row.token,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    usedCount: row.used_count,
    createdAt: row.created_at,
  };
}

export async function createStaffInviteAction(role: OrgRole): Promise<ActionResult<StaffInvite>> {
  try {
    const context = await requireOrgRole(["owner", "manager"]);

    if (!ORG_ROLES.includes(role)) {
      throw new RbacError("유효하지 않은 역할입니다.");
    }

    if (!context.organizationId) {
      throw new RbacError("소속된 공급사 조직이 없습니다.");
    }

    if (!context.isSuperAdmin && (!context.orgRole || !canAssignRole(context.orgRole, role))) {
      throw new RbacError("해당 역할의 초대 링크를 만들 권한이 없습니다.");
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("organization_staff_invites")
      .insert({ organization_id: context.organizationId, role, created_by: context.userId })
      .select("id, role, token, expires_at, revoked_at, used_count, created_at")
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? "초대 링크 생성에 실패했습니다.");
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: toStaffInvite(data as StaffInviteRow) };
  } catch (error) {
    return toResult(error);
  }
}

export async function listStaffInvitesAction(): Promise<ActionResult<StaffInvite[]>> {
  try {
    const context = await requireOrgRole(["owner", "manager"]);

    if (!context.organizationId) {
      return { success: true, data: [] };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("organization_staff_invites")
      .select("id, role, token, expires_at, revoked_at, used_count, created_at")
      .eq("organization_id", context.organizationId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    return { success: true, data: ((data ?? []) as StaffInviteRow[]).map(toStaffInvite) };
  } catch (error) {
    return toResult(error);
  }
}

export async function revokeStaffInviteAction(inviteId: string): Promise<ActionResult> {
  try {
    const context = await requireOrgRole(["owner", "manager"]);

    const supabase = await createClient();
    const { data: target, error: targetError } = await supabase
      .from("organization_staff_invites")
      .select("id, organization_id")
      .eq("id", inviteId)
      .maybeSingle();

    if (targetError || !target) {
      throw new RbacError("초대 링크를 찾을 수 없습니다.");
    }

    if (!context.isSuperAdmin && target.organization_id !== context.organizationId) {
      throw new RbacError("다른 조직의 초대 링크는 취소할 수 없습니다.");
    }

    const { error } = await supabase
      .from("organization_staff_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", inviteId);

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 3. 직원 역할 변경 (owner 전용)
// ====================================================================
export async function updateStaffRole(
  staffId: string,
  newRole: OrgRole
): Promise<ActionResult> {
  try {
    const context = await requireOrgRole(["owner"]);

    if (!ORG_ROLES.includes(newRole)) {
      throw new RbacError("유효하지 않은 역할입니다.");
    }

    const supabase = await createClient();

    const { data: target, error: targetError } = await supabase
      .from("organization_staff")
      .select("id, organization_id, user_id, role")
      .eq("id", staffId)
      .maybeSingle();

    if (targetError || !target) {
      throw new RbacError("대상 직원을 찾을 수 없습니다.");
    }

    if (!context.isSuperAdmin && target.organization_id !== context.organizationId) {
      throw new RbacError("다른 조직의 직원은 변경할 수 없습니다.");
    }

    if (target.user_id === context.userId) {
      throw new RbacError("본인의 역할은 변경할 수 없습니다.");
    }

    if (target.role === newRole) {
      return { success: true };
    }

    // 마지막 owner 강등은 DB 트리거(guard_last_organization_owner)가 최종 차단
    const { error } = await supabase
      .from("organization_staff")
      .update({ role: newRole })
      .eq("id", staffId);

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 4. 직원 삭제 (owner 전용 / 본인 자진 탈퇴 허용)
// ====================================================================
export async function removeStaff(staffId: string): Promise<ActionResult> {
  try {
    const context = await requireSession();

    const supabase = await createClient();

    const { data: target, error: targetError } = await supabase
      .from("organization_staff")
      .select("id, organization_id, user_id, role")
      .eq("id", staffId)
      .maybeSingle();

    if (targetError || !target) {
      throw new RbacError("대상 직원을 찾을 수 없습니다.");
    }

    const isSelf = target.user_id === context.userId;
    const isOwner = context.orgRole === "owner" && target.organization_id === context.organizationId;

    if (!isSelf && !isOwner && !context.isSuperAdmin) {
      throw new RbacError("직원을 삭제할 권한이 없습니다.");
    }

    // 이 사람이 만들어둔, 아직 안 쓰인 초대 링크를 먼저 회수한다. 삭제 후에는(특히
    // 본인 탈퇴 케이스) RLS가 이미 조직 role을 잃은 행위자의 UPDATE를 막으므로
    // organization_staff 삭제보다 반드시 먼저 실행해야 한다. 실패해도 직원 삭제
    // 자체는 막지 않는다(다른 owner/manager가 팀 관리 화면에서 수동 취소 가능).
    const { error: revokeError } = await supabase
      .from("organization_staff_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("organization_id", target.organization_id)
      .eq("created_by", target.user_id)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString());

    if (revokeError) {
      console.error("[RemoveStaff] 초대 링크 회수 실패:", revokeError.message);
    }

    // 마지막 owner 삭제는 DB 트리거가 최종 차단
    const { error } = await supabase.from("organization_staff").delete().eq("id", staffId);

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true };
  } catch (error) {
    return toResult(error);
  }
}

// ====================================================================
// 5. 조직 직원 목록 조회 (같은 조직 구성원만 — RLS로 이중 차단)
//    profiles SELECT RLS는 본인 것만 허용하므로 이름/연락처는
//    list_organization_staff_with_profiles() RPC로 조회한다.
// ====================================================================
export interface OrganizationStaffMember {
  id: string;
  userId: string;
  role: OrgRole;
  name: string | null;
  phone: string | null;
  createdAt: string;
}

interface OrganizationStaffMemberRow {
  id: string;
  user_id: string;
  role: OrgRole;
  name: string | null;
  phone: string | null;
  created_at: string;
}

export async function listOrganizationStaff(): Promise<ActionResult<OrganizationStaffMember[]>> {
  try {
    const context = await requireOrgRole(["owner", "manager", "staff"]);

    if (!context.organizationId) {
      return { success: true, data: [] };
    }

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("list_organization_staff_with_profiles", {
      p_organization_id: context.organizationId,
    });

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      data: ((data ?? []) as OrganizationStaffMemberRow[]).map((row) => ({
        id: row.id,
        userId: row.user_id,
        role: row.role,
        name: row.name,
        phone: row.phone,
        createdAt: row.created_at,
      })),
    };
  } catch (error) {
    return toResult(error);
  }
}
