"use server";

import { revalidatePath } from "next/cache";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
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
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REVALIDATE_PATH = "/wholesaler/staff";

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof RbacError) {
    return { success: false, error: error.message };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.",
  };
}

/**
 * Service Role 클라이언트. auth.admin API(사용자 초대/조회)에만 사용하며
 * 절대 브라우저로 노출되지 않는다. 호출 전 반드시 RBAC 검증을 통과해야 한다.
 */
function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey || serviceRoleKey.includes("your-supabase")) {
    throw new RbacError("서버에 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않아 초대를 보낼 수 없습니다.");
  }

  return createSupabaseAdminClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** 이메일로 기존 auth 사용자 조회 (없으면 null) */
async function findUserIdByEmail(
  admin: ReturnType<typeof createAdminClient>,
  email: string
): Promise<string | null> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });

    if (error) {
      throw new Error(`사용자 조회 실패: ${error.message}`);
    }

    const match = data.users.find((user) => user.email?.toLowerCase() === email);

    if (match) {
      return match.id;
    }

    if (data.users.length < 200) {
      break;
    }
  }

  return null;
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
// 2. 직원 초대 (owner / manager)
// ====================================================================
export async function inviteStaff(formData: FormData): Promise<ActionResult> {
  try {
    const context = await requireOrgRole(["owner", "manager"]);

    const email = ((formData.get("email") as string) || "").trim().toLowerCase();
    const roleInput = ((formData.get("role") as string) || "staff").trim();
    const organizationId =
      ((formData.get("organization_id") as string) || "").trim() || context.organizationId;

    if (!EMAIL_PATTERN.test(email)) {
      throw new RbacError("올바른 이메일 주소를 입력해주세요.");
    }

    if (!organizationId) {
      throw new RbacError("대상 조직을 특정할 수 없습니다.");
    }

    if (!context.isSuperAdmin && organizationId !== context.organizationId) {
      throw new RbacError("다른 조직의 직원을 초대할 수 없습니다.");
    }

    if (!ORG_ROLES.includes(roleInput as OrgRole)) {
      throw new RbacError("유효하지 않은 역할입니다.");
    }

    const role = roleInput as OrgRole;

    if (!context.isSuperAdmin && (!context.orgRole || !canAssignRole(context.orgRole, role))) {
      throw new RbacError("해당 역할을 부여할 권한이 없습니다.");
    }

    if (email === context.email) {
      throw new RbacError("본인은 초대할 수 없습니다.");
    }

    const admin = createAdminClient();

    let userId = await findUserIdByEmail(admin, email);

    if (!userId) {
      const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email);

      if (inviteError || !invited.user) {
        throw new Error(`초대 메일 발송 실패: ${inviteError?.message ?? "사용자 생성 실패"}`);
      }

      userId = invited.user.id;
    }

    const supabase = await createClient();
    const { error: staffError } = await supabase.from("organization_staff").insert({
      organization_id: organizationId,
      user_id: userId,
      role,
      invited_by: context.userId,
    });

    if (staffError) {
      if (staffError.code === "23505") {
        throw new RbacError("이미 조직에 소속된 사용자입니다.");
      }
      throw new Error(staffError.message);
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
// ====================================================================
export async function listOrganizationStaff(): Promise<
  ActionResult<Array<{ id: string; user_id: string; role: OrgRole; created_at: string }>>
> {
  try {
    const context = await requireOrgRole(["owner", "manager", "staff"]);

    if (!context.organizationId) {
      return { success: true, data: [] };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("organization_staff")
      .select("id, user_id, role, created_at")
      .eq("organization_id", context.organizationId)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(error.message);
    }

    return {
      success: true,
      data: (data ?? []) as Array<{
        id: string;
        user_id: string;
        role: OrgRole;
        created_at: string;
      }>,
    };
  } catch (error) {
    return toResult(error);
  }
}
