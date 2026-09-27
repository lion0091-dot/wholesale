"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RbacError, requireOrgRole, type OrgRole } from "@/lib/auth/rbac";
import { getSupplierScope } from "@/lib/supplier/scope";
import { validateReceivingPolicy, type ReceivingPolicy, type ReceivingPolicyInput } from "@/lib/receiving-policy/policy";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

/** 수용 기준은 발주서와 같은 기준 — owner/manager만 바꾼다(직원은 조회만, DB RLS도 같다). */
const RECEIVING_POLICY_ROLES: OrgRole[] = ["owner", "manager"];

export async function saveReceivingPolicyAction(input: ReceivingPolicyInput): Promise<ActionResult<{ policy: ReceivingPolicy }>> {
  try {
    await requireOrgRole(RECEIVING_POLICY_ROLES);

    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      throw new RbacError("공급사 업체 정보가 없어 입고 기준을 저장할 수 없습니다.");
    }

    const checked = validateReceivingPolicy(input);

    if (!checked.ok) {
      throw new RbacError(checked.error);
    }

    const supabase = await createClient();
    const { error } = await supabase.from("receiving_policies").upsert(
      {
        wholesaler_id: scope.wholesalerId,
        over_tolerance_mode: checked.policy.overToleranceMode,
        over_tolerance_value: checked.policy.overToleranceValue,
        unlisted_item_policy: checked.policy.unlistedItemPolicy,
        line_assignment: checked.policy.lineAssignment,
        updated_by: scope.userId,
      },
      { onConflict: "wholesaler_id" }
    );

    if (error) {
      throw new Error(error.message);
    }

    revalidatePath("/dashboard/receiving-policy");
    return { success: true, data: { policy: checked.policy } };
  } catch (error) {
    if (error instanceof RbacError) {
      return { success: false, error: error.message };
    }

    return { success: false, error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다." };
  }
}
