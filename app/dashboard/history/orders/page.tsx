import { isSuperAdminWithoutScope, getSupplierScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { DEFAULT_ORDER_HISTORY_DAYS } from "@/lib/orders/history-range";
import { listOrdersForHistoryAction } from "./actions";
import { OrderHistoryPicker } from "./order-history-picker";

export const metadata = {
  title: "발주 이력 | 도매업체 통합관리시스템",
};

export default async function OrderHistoryPickerPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const initial = scope?.wholesalerId
    ? await listOrdersForHistoryAction(DEFAULT_ORDER_HISTORY_DAYS, 0)
    : { success: true as const, data: { entries: [], totalCount: 0, hasMore: false } };

  const data = initial.success && initial.data ? initial.data : { entries: [], totalCount: 0, hasMore: false };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>발주 이력</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          발주서를 찾아 상태·결제·배송 변경 이력을 확인합니다.
        </p>
      </header>

      <OrderHistoryPicker
        initialEntries={data.entries}
        initialTotalCount={data.totalCount}
        initialHasMore={data.hasMore}
        initialRangeDays={DEFAULT_ORDER_HISTORY_DAYS}
        hasWholesaler={Boolean(scope?.wholesalerId)}
      />
    </div>
  );
}
