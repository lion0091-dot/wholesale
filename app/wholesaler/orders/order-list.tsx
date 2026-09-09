"use client";

import { useState } from "react";
import { updateOrderStatusAction } from "./actions";
import type { Order, OrderItem, OrderStatus } from "@/types/database";

export interface OrderWithDetails extends Order {
  retailer_name?: string;
  items: OrderItem[];
}

interface OrderListProps {
  initialOrders: OrderWithDetails[];
}

const STATUS_LABELS: Record<OrderStatus, { label: string; bg: string; color: string }> = {
  pending: { label: "신규 접수", bg: "#fef3c7", color: "#92400e" },
  confirmed: { label: "접수 확인", bg: "#dbeafe", color: "#1e40af" },
  shipping: { label: "배송 중", bg: "#e0e7ff", color: "#3730a3" },
  delivered: { label: "배송 완료", bg: "#dcfce7", color: "#166534" },
  cancelled: { label: "주문 취소", bg: "#fee2e2", color: "#991b1b" },
};

export function OrderList({ initialOrders }: OrderListProps) {
  const [orders, setOrders] = useState<OrderWithDetails[]>(initialOrders);
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [loadingOrderId, setLoadingOrderId] = useState<string | null>(null);

  const filteredOrders = orders.filter((order) => {
    if (activeFilter === "all") return true;
    return order.status === activeFilter;
  });

  const handleStatusChange = async (orderId: string, nextStatus: OrderStatus) => {
    setLoadingOrderId(orderId);
    try {
      const res = await updateOrderStatusAction(orderId, nextStatus);
      if (res.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? { ...o, status: nextStatus } : o))
        );
      } else {
        alert(res.error || "상태 변경 실패");
      }
    } catch {
      alert("오류가 발생했습니다.");
    } finally {
      setLoadingOrderId(null);
    }
  };

  return (
    <div>
      {/* 상태 필터 탭 */}
      <div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "8px", marginBottom: "20px" }}>
        {(["all", "pending", "confirmed", "shipping", "delivered", "cancelled"] as const).map((filter) => {
          const count = filter === "all" ? orders.length : orders.filter((o) => o.status === filter).length;
          const label = filter === "all" ? "전체" : STATUS_LABELS[filter]?.label;
          const isSelected = activeFilter === filter;

          return (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              style={{
                padding: "8px 16px",
                borderRadius: "20px",
                fontSize: "13px",
                fontWeight: isSelected ? 700 : 500,
                border: isSelected ? "1px solid #0f172a" : "1px solid #e2e8f0",
                backgroundColor: isSelected ? "#0f172a" : "#ffffff",
                color: isSelected ? "#ffffff" : "#475569",
                cursor: "pointer",
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span>{label}</span>
              <span
                style={{
                  fontSize: "11px",
                  padding: "1px 6px",
                  borderRadius: "10px",
                  backgroundColor: isSelected ? "#334155" : "#f1f5f9",
                  color: isSelected ? "#f8fafc" : "#64748b",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 발주 목록 */}
      {filteredOrders.length === 0 ? (
        <div
          style={{
            backgroundColor: "#ffffff",
            borderRadius: "12px",
            border: "1px dashed #cbd5e1",
            padding: "48px 16px",
            textAlign: "center",
            color: "#64748b",
          }}
        >
          해당 상태의 발주 내역이 없습니다.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {filteredOrders.map((order) => {
            const statusConfig = STATUS_LABELS[order.status] || STATUS_LABELS.pending;
            const isBusy = loadingOrderId === order.id;

            return (
              <div
                key={order.id}
                style={{
                  backgroundColor: "#ffffff",
                  borderRadius: "12px",
                  padding: "20px",
                  border: "1px solid #e2e8f0",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                {/* 발주서 헤더 */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "8px", borderBottom: "1px solid #f1f5f9", paddingBottom: "12px" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                        {order.order_number}
                      </span>
                      <span
                        style={{
                          fontSize: "12px",
                          fontWeight: 700,
                          padding: "3px 8px",
                          borderRadius: "6px",
                          backgroundColor: statusConfig.bg,
                          color: statusConfig.color,
                        }}
                      >
                        {statusConfig.label}
                      </span>
                    </div>
                    <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
                      발주 식당: <strong>{order.retailer_name || "단골 거래처 식당"}</strong> | 접수일시: {new Date(order.ordered_at).toLocaleString("ko-KR")}
                    </p>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: "12px", color: "#64748b" }}>총 발주 금액</span>
                    <div style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a" }}>
                      {Number(order.total_amount).toLocaleString()}원
                    </div>
                  </div>
                </div>

                {/* 주문 품목 목록 */}
                <div style={{ margin: "16px 0", backgroundColor: "#f8fafc", borderRadius: "8px", padding: "12px" }}>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "8px" }}>
                    발주 품목 내역 ({order.items.length}개)
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {order.items.map((item, idx) => (
                      <div
                        key={item.id || idx}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: "13px",
                          color: "#1e293b",
                        }}
                      >
                        <span>
                          <strong>{item.product_name}</strong> × {item.quantity}
                        </span>
                        <span style={{ fontWeight: 600 }}>
                          {Number(item.subtotal_amount).toLocaleString()}원
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 배송지 정보 및 배송 메모 */}
                <div style={{ fontSize: "12px", color: "#475569", marginBottom: "16px", lineHeight: "1.6" }}>
                  <div>
                    <strong>배송지:</strong> {order.delivery_address}
                  </div>
                  {order.delivery_notes && (
                    <div style={{ color: "#b45309", marginTop: "2px" }}>
                      <strong>배송 메모:</strong> {order.delivery_notes}
                    </div>
                  )}
                </div>

                {/* 상태 변경 액션 버튼 */}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", borderTop: "1px solid #f1f5f9", paddingTop: "12px" }}>
                  {order.status === "pending" && (
                    <>
                      <button
                        disabled={isBusy}
                        onClick={() => handleStatusChange(order.id, "confirmed")}
                        style={{
                          backgroundColor: "#0f172a",
                          color: "#ffffff",
                          fontSize: "13px",
                          fontWeight: 600,
                          padding: "6px 14px",
                          borderRadius: "6px",
                          border: "none",
                          cursor: isBusy ? "not-allowed" : "pointer",
                        }}
                      >
                        {isBusy ? "처리 중..." : "접수 확인"}
                      </button>
                      <button
                        disabled={isBusy}
                        onClick={() => {
                          if (confirm("이 발주서를 취소 처리하시겠습니까?")) {
                            handleStatusChange(order.id, "cancelled");
                          }
                        }}
                        style={{
                          backgroundColor: "#ffffff",
                          color: "#dc2626",
                          fontSize: "13px",
                          fontWeight: 600,
                          padding: "6px 14px",
                          borderRadius: "6px",
                          border: "1px solid #fca5a5",
                          cursor: isBusy ? "not-allowed" : "pointer",
                        }}
                      >
                        주문 취소
                      </button>
                    </>
                  )}

                  {order.status === "confirmed" && (
                    <button
                      disabled={isBusy}
                      onClick={() => handleStatusChange(order.id, "shipping")}
                      style={{
                        backgroundColor: "#2563eb",
                        color: "#ffffff",
                        fontSize: "13px",
                        fontWeight: 600,
                        padding: "6px 14px",
                        borderRadius: "6px",
                        border: "none",
                        cursor: isBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {isBusy ? "처리 중..." : "출고 / 배송 시작"}
                    </button>
                  )}

                  {order.status === "shipping" && (
                    <button
                      disabled={isBusy}
                      onClick={() => handleStatusChange(order.id, "delivered")}
                      style={{
                        backgroundColor: "#16a34a",
                        color: "#ffffff",
                        fontSize: "13px",
                        fontWeight: 600,
                        padding: "6px 14px",
                        borderRadius: "6px",
                        border: "none",
                        cursor: isBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {isBusy ? "처리 중..." : "배송 완료"}
                    </button>
                  )}

                  {(order.status === "delivered" || order.status === "cancelled") && (
                    <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                      처리 완료된 발주서입니다.
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
