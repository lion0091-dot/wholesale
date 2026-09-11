import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { DEMO_ORDERS } from "@/lib/demo/supplier-samples";
import { formatWon, isAlimtalkLiveChannel } from "@/lib/orders/status";
import { OrderBoard, type OrderRow } from "./order-board";
import type { OrderItem, OrderStatus } from "@/types/database";

export const metadata = {
  title: "주문 관리 | 공급사 백오피스",
};

/** orders + order_items + retailers 조인 응답 형태 */
interface OrderJoinRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  total_amount: number;
  delivery_address: string;
  ordered_at: string;
  order_items: Pick<OrderItem, "product_name" | "quantity">[] | null;
  retailers: { restaurant_name: string } | { restaurant_name: string }[] | null;
}

function retailerName(row: OrderJoinRow): string {
  const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;

  return retailer?.restaurant_name ?? "이름 미등록 바이어";
}

/** "한우 1++ 등심 2 외 2건" 형태의 품목 요약 */
function summarizeItems(items: Pick<OrderItem, "product_name" | "quantity">[]): string {
  if (items.length === 0) {
    return "품목 정보 없음";
  }

  const [first] = items;
  const head = `${first.product_name} ${Number(first.quantity)}`;

  return items.length > 1 ? `${head} 외 ${items.length - 1}건` : head;
}

export default async function DashboardOrdersPage() {
  const scope = await getSupplierScope();

  let orders: OrderRow[] = [];
  let isDemoData = true;

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("orders")
      .select(
        "id, order_number, status, total_amount, delivery_address, ordered_at, order_items ( product_name, quantity ), retailers ( restaurant_name )"
      )
      .eq("wholesaler_id", scope.wholesalerId)
      .order("ordered_at", { ascending: false });

    if (data && data.length > 0) {
      orders = (data as OrderJoinRow[]).map((row) => {
        const items = row.order_items ?? [];

        return {
          id: row.id,
          orderNumber: row.order_number,
          retailerName: retailerName(row),
          status: row.status,
          totalAmount: Number(row.total_amount),
          itemCount: items.length,
          itemSummary: summarizeItems(items),
          orderedAt: row.ordered_at,
          deliveryAddress: row.delivery_address,
        };
      });
      isDemoData = false;
    }
  }

  if (isDemoData) {
    orders = DEMO_ORDERS.map((order) => ({
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
  }

  const pendingCount = orders.filter((order) => order.status === "pending").length;
  const inProgressCount = orders.filter(
    (order) => order.status === "confirmed" || order.status === "shipping"
  ).length;
  const activeAmount = orders
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + order.totalAmount, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>주문 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          미니샵으로 접수된 발주서를 상태별로 확인하고 출고·배송 처리를 진행합니다. 알림톡은 주문
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
        orders={orders}
        isLiveChannel={isAlimtalkLiveChannel()}
        readOnly={isDemoData}
      />
    </div>
  );
}
