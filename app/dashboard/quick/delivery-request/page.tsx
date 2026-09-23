import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { ACTIVE_ORDER_STATUSES } from "@/lib/orders/status";
import { ORDER_LIST_SELECT_COLUMNS, mapOrderJoinRow, type OrderJoinRow, type OrderRow } from "@/lib/orders/order-row";
import { signExternalOpenToken } from "@/lib/pdf/external-open-token";
import { QuickDeliveryRequestView, type QuickDeliveryRequestRow } from "./quick-delivery-request-view";

export const metadata = {
  title: "배송의뢰서 | 도매업체 통합관리시스템",
};

/**
 * 모바일 현장용 배송의뢰서 확인/재발급 — 발주 상세 화면에 묻혀 있던 버튼을
 * 검색 한 번으로 바로 찾을 수 있게 뽑아냈다. PDF 생성 자체(가격 없는 배송의뢰서)는
 * 기존 라우트(app/dashboard/orders/[id]/delivery-request/route.ts)를 그대로 쓴다.
 */
export default async function QuickDeliveryRequestPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let rows: QuickDeliveryRequestRow[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const { data } = await supabase
      .from("orders")
      .select(ORDER_LIST_SELECT_COLUMNS)
      .eq("wholesaler_id", scope.wholesalerId)
      .in("status", ACTIVE_ORDER_STATUSES)
      .order("ordered_at", { ascending: false });

    const orders = ((data ?? []) as OrderJoinRow[]).map(mapOrderJoinRow);
    const wholesalerId = scope.wholesalerId;

    rows = orders.map((order) => ({
      ...order,
      externalOpenHref: signExternalOpenToken({
        kind: "delivery-request",
        orderId: order.id,
        wholesalerId,
      }),
    }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>배송의뢰서</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          택배기사에게 바로 넘길 배송의뢰서를 찾아 엽니다. 가격이 없는 발송용 문서라
          거래명세서와는 다릅니다.
        </p>
      </header>

      <QuickDeliveryRequestView rows={rows} />
    </div>
  );
}
