import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { DEMO_ORDERS } from "@/lib/demo/supplier-samples";
import { formatWon, ACTIVE_ORDER_STATUSES, HISTORICAL_ORDER_STATUSES } from "@/lib/orders/status";
import { isAlimtalkConfiguredForWholesaler } from "@/lib/notifications/alimtalk";
import {
  ORDER_LIST_SELECT_COLUMNS,
  mapOrderJoinRow,
  summarizeItems,
  type OrderJoinRow,
  type OrderRow,
} from "@/lib/orders/order-row";
import { DEFAULT_ORDER_HISTORY_DAYS, ORDER_HISTORY_PAGE_SIZE } from "@/lib/orders/history-range";
import { OrderBoard } from "./order-board";

export const metadata = {
  title: "발주 관리 | 도매업체 통합관리시스템",
};

function historyCutoffISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export default async function DashboardOrdersPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let activeOrders: OrderRow[] = [];
  let historicalOrders: OrderRow[] = [];
  let historyTotalCount = 0;
  let isDemoData = true;
  /** 배송완료/취소 카드 합계는 목록과 달리 항상 전체 기간 기준이어야 해서 별도 집계로 가져온다. */
  let activeAmount = 0;
  /** 이 공급사가 비즈뿌리오 계정을 등록했는지 — 등록 전엔 알림톡이 콘솔 로그로만 남는다. */
  let isLiveChannel = false;

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const [{ data: activeData }, { data: historicalData, count: historicalCount }, { data: activeAmountData }, liveChannel] =
      await Promise.all([
        supabase
          .from("orders")
          .select(ORDER_LIST_SELECT_COLUMNS)
          .eq("wholesaler_id", scope.wholesalerId)
          .in("status", ACTIVE_ORDER_STATUSES)
          .order("ordered_at", { ascending: false }),
        supabase
          .from("orders")
          .select(ORDER_LIST_SELECT_COLUMNS, { count: "exact" })
          .eq("wholesaler_id", scope.wholesalerId)
          .in("status", HISTORICAL_ORDER_STATUSES)
          .gte("ordered_at", historyCutoffISO(DEFAULT_ORDER_HISTORY_DAYS))
          .order("ordered_at", { ascending: false })
          .range(0, ORDER_HISTORY_PAGE_SIZE - 1),
        supabase.rpc("get_order_active_amount", { p_wholesaler_id: scope.wholesalerId }),
        isAlimtalkConfiguredForWholesaler(scope.wholesalerId),
      ]);

    isLiveChannel = liveChannel;

    const hasAny = (activeData?.length ?? 0) > 0 || (historicalData?.length ?? 0) > 0;

    if (hasAny) {
      activeOrders = ((activeData ?? []) as OrderJoinRow[]).map(mapOrderJoinRow);
      historicalOrders = ((historicalData ?? []) as OrderJoinRow[]).map(mapOrderJoinRow);
      historyTotalCount = historicalCount ?? 0;
      activeAmount = Number(activeAmountData ?? 0);
      isDemoData = false;
    }
  }

  if (isDemoData) {
    const demoRows: OrderRow[] = DEMO_ORDERS.map((order) => ({
      id: order.id,
      orderNumber: order.order_number,
      retailerName: order.retailer_name,
      status: order.status,
      totalAmount: Number(order.total_amount),
      itemCount: order.items.length,
      itemSummary: summarizeItems(order.items),
      orderedAt: order.ordered_at,
      deliveryAddress: order.delivery_address,
    }));

    activeOrders = demoRows.filter((row) => ACTIVE_ORDER_STATUSES.includes(row.status));
    historicalOrders = demoRows.filter((row) => HISTORICAL_ORDER_STATUSES.includes(row.status));
    historyTotalCount = historicalOrders.length;
    activeAmount = demoRows
      .filter((row) => row.status !== "cancelled")
      .reduce((sum, row) => sum + row.totalAmount, 0);
  }

  const pendingCount = activeOrders.filter((order) => order.status === "pending").length;
  const inProgressCount = activeOrders.filter(
    (order) => order.status === "confirmed" || order.status === "shipping"
  ).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>발주 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          미니샵으로 접수된 발주서를 상태별로 확인하고 출고·배송 처리를 진행합니다. 알림톡은 발주
          접수 및 상태 변경 시점에 자동 발송됩니다.
        </p>
      </header>

      {isDemoData && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
          }}
        >
          ℹ️ 접수된 발주서가 없거나 미인증(데모) 상태여서 샘플 발주서를 표시하고 있습니다. 샘플
          발주서는 상태 변경이 동작하지 않습니다.
        </div>
      )}

      <section className="dash-cards">
        {[
          { label: "접수대기", value: `${pendingCount}건`, accent: "#b45309" },
          { label: "진행중 (확정/배송중)", value: `${inProgressCount}건`, accent: "#1d4ed8" },
          { label: "누적 발주 금액 (취소 제외)", value: formatWon(activeAmount), accent: "#0f172a" },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "12px",
              padding: "14px 16px",
            }}
          >
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>{card.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 800, color: card.accent, marginTop: "4px" }}>
              {card.value}
            </div>
          </div>
        ))}
      </section>

      <OrderBoard
        activeOrders={activeOrders}
        initialHistoricalOrders={historicalOrders}
        initialHistoryRangeDays={DEFAULT_ORDER_HISTORY_DAYS}
        initialHistoryTotalCount={historyTotalCount}
        initialHistoryHasMore={historicalOrders.length < historyTotalCount}
        isLiveChannel={isLiveChannel}
        isDemo={isDemoData}
      />
    </div>
  );
}
