import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import {
  buildReceivableGroups,
  type ReceivableCreditOrderRow,
  type ReceivableCustomerGroup,
  type ReceivableRelationRow,
} from "@/lib/orders/receivables";
import { QuickSettleView } from "./quick-settle-view";

export const metadata = {
  title: "수금 확인 | 도매업체 통합관리시스템",
};

/**
 * 모바일 현장용 수금 확인 — 전체 화면(/dashboard/receivables)은 감사이력·리마인드
 * 발송까지 같이 있어 무겁다. 여긴 "거래처 이름 + 미수금 + 정산 처리" 버튼만 남긴다.
 * 데이터는 전체 화면과 완전히 같은 쿼리·묶음 로직(buildReceivableGroups)을 재사용한다.
 */
export default async function QuickSettlePage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let groups: ReceivableCustomerGroup[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: relations }, { data: creditOrders }] = await Promise.all([
      supabase
        .from("wholesaler_retailers")
        .select(
          "retailer_id, credit_limit, outstanding_balance, settlement_due_days, retailers ( restaurant_name )"
        )
        .eq("wholesaler_id", scope.wholesalerId),
      supabase
        .from("orders")
        .select("id, order_number, retailer_id, total_amount, ordered_at")
        .eq("wholesaler_id", scope.wholesalerId)
        .eq("payment_method", "on_credit")
        .is("settled_at", null)
        .neq("status", "cancelled"),
    ]);

    groups = buildReceivableGroups(
      (relations ?? []) as ReceivableRelationRow[],
      (creditOrders ?? []) as ReceivableCreditOrderRow[]
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>수금 확인</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          현장에서 바로 받은 수금을 정산 처리합니다. 이력 조회·리마인드 발송은 PC의
          미수금 정산 화면을 이용하세요.
        </p>
      </header>

      <QuickSettleView groups={groups} />
    </div>
  );
}
