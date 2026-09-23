"use client";

import { useMemo, useState } from "react";
import { ORDER_STATUS_BADGES, formatOrderedAt, formatWon } from "@/lib/orders/status";
import { OrderStatusPanel } from "@/app/dashboard/orders/[id]/order-status-panel";
import type { OrderRow } from "@/lib/orders/order-row";

const cardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  backgroundColor: "#fff",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

export function QuickOrdersView({ orders }: { orders: OrderRow[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) return orders;

    return orders.filter(
      (order) =>
        order.retailerName.toLowerCase().includes(query) ||
        order.orderNumber.toLowerCase().includes(query)
    );
  }, [orders, search]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <input
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="거래처명 또는 발주번호 검색"
        aria-label="발주 검색"
        style={{
          padding: "10px 12px",
          borderRadius: "8px",
          border: "1px solid #cbd5e1",
          fontSize: "14px",
        }}
      />

      {filtered.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>
          {orders.length === 0 ? "처리할 진행중 발주가 없습니다." : "검색 결과가 없습니다."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {filtered.map((order) => {
            const badge = ORDER_STATUS_BADGES[order.status];

            return (
              <div key={order.id} style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                      {order.retailerName}
                    </div>
                    <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                      {order.orderNumber} · {formatOrderedAt(order.orderedAt)}
                    </div>
                  </div>

                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      backgroundColor: badge.bg,
                      color: badge.color,
                      borderRadius: "4px",
                      padding: "3px 8px",
                      height: "fit-content",
                    }}
                  >
                    {badge.label}
                  </span>
                </div>

                <div style={{ fontSize: "13px", color: "#334155" }}>{order.itemSummary}</div>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
                  {formatWon(order.totalAmount)}
                </div>

                <OrderStatusPanel orderId={order.id} currentStatus={order.status} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
