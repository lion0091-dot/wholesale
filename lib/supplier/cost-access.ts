import type { SupabaseClient } from "@supabase/supabase-js";
import { RbacError, requireSession } from "@/lib/auth/rbac";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import type { OrgRole } from "@/lib/auth/rbac";

/**
 * 원가(매입단가·금액, 전표 단가, 기본 매입단가)를 보고 입력할 수 있는 사람. 기본은 대표 + 전표 담당 직원(최대 2명)이고,
 * 업체마다 다르게 정할 수 있다(wholesalers.cost_access_policy — 마이그레이션 209, docs/cost-access.md). 슈퍼관리자는 못 본다.
 *
 * 진짜 막는 곳은 DB다(can_view_cost). 이 함수는 화면을 그리거나 액션을 일찍 거절하려는 용도라서,
 * 대표는 DB 왕복 없이 바로 답하고 나머지는 업체 정책을 따르는 DB에 묻는다.
 */
export async function resolveCostAccess(
  supabase: SupabaseClient,
  scope: { orgRole: OrgRole | null; wholesalerId: string | null } | null
): Promise<boolean> {
  if (!scope?.wholesalerId) return false;
  if (scope.orgRole === "owner") return true;

  const { data, error } = await supabase.rpc("can_view_cost", { p_wholesaler_id: scope.wholesalerId });

  return !error && data === true;
}

/** 서버 액션용 — 원가를 만지는 동작은 대표·전표 담당만. 아니면 RbacError. */
export async function requireCostAccess(): Promise<void> {
  await requireSession();

  const scope = await getSupplierScope();
  const allowed = await resolveCostAccess(await createClient(), scope);

  if (!allowed) {
    throw new RbacError("이 작업은 대표님과 전표 담당 직원만 할 수 있습니다.");
  }
}
