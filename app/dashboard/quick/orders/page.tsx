import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { ACTIVE_ORDER_STATUSES } from "@/lib/orders/status";
import { ORDER_LIST_SELECT_COLUMNS, mapOrderJoinRow, type OrderJoinRow, type OrderRow } from "@/lib/orders/order-row";
import { QuickOrdersView } from "./quick-orders-view";

export const metadata = {
  title: "발주 처리 | 도매업체 통합관리시스템",
};

/**
 * 모바일 현장용 발주 처리 — 전체 화면(/dashboard/orders)은 완료·취소 이력 구간
 * 조회까지 같이 있어 무겁다. 여긴 지금 처리해야 하는 진행중 발주만 보여주고,
 * 상태 변경은 발주 상세 화면과 완전히 같은 컴포넌트(OrderStatusPanel)를 그대로 쓴다.
 */
export default async function QuickOrdersPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let orders: OrderRow[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const { data } = await supabase
      .from("orders")
      .select(ORDER_LIST_SELECT_COLUMNS)
      .eq("wholesaler_id", scope.wholesalerId)
      .in("status", ACTIVE_ORDER_STATUSES)
      .order("ordered_at", { ascending: false });

    orders = ((data ?? []) as OrderJoinRow[]).map(mapOrderJoinRow);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>발주 처리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          지금 처리해야 하는 진행중 발주만 보여줍니다. 완료·취소 이력은 PC의 발주 관리
          화면을 이용하세요.
        </p>
      </header>

      <QuickOrdersView orders={orders} />
    </div>
  );
}
