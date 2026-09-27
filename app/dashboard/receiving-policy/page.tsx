import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { policyFromRow, type ReceivingPolicy } from "@/lib/receiving-policy/policy";
import { SettingsHeader } from "../settings-tabs";
import { ReceivingPolicyForm } from "./receiving-policy-form";

export const metadata = {
  title: "입고 기준 | 미트 파트너스",
};

/** 물건이 도착했을 때 받아도 되는지·어느 발주서에 붙일지의 기준 — 업체가 직접 정한다. */
export default async function ReceivingPolicyPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const canManage = Boolean(
    scope &&
      (scope.isSuperAdmin ||
        scope.orgRole === "owner" ||
        scope.orgRole === "manager" ||
        (!scope.organizationId && scope.wholesalerId))
  );

  let policy: ReceivingPolicy = policyFromRow(null);

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("receiving_policies")
      .select("over_tolerance_mode, over_tolerance_value, unlisted_item_policy")
      .eq("wholesaler_id", scope.wholesalerId)
      .maybeSingle();

    policy = policyFromRow(data);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <SettingsHeader />
      <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>
        공급처 물건이 도착했을 때 어디까지 받을지 정해 둡니다. 저장해 둔 기준은 물건을 발주서와 맞춰 볼 때 적용됩니다. 같은 물건이 여러 발주서에 걸려 있으면 오래된 발주서부터 채워 갑니다.
      </p>
      <ReceivingPolicyForm initial={policy} canManage={canManage} />
    </div>
  );
}
