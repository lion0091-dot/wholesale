"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ORDER_STATUS_BADGES,
  ORDER_STATUS_FILTERS,
  formatOrderedAt,
  formatWon,
  resolveAlimtalkStatus,
} from "@/lib/orders/status";
import type { OrderStatus } from "@/types/database";

/** 목록 테이블 1행에 필요한 최소 정보 */
export interface OrderRow {
  id: string;
  orderNumber: string;
  retailerName: string;
  status: OrderStatus;
  totalAmount: number;
  itemCount: number;
  itemSummary: string;
  orderedAt: string;
  deliveryAddress: string;
}

interface OrderBoardProps {
  orders: OrderRow[];
  /** 알림톡 실발송 채널 사용 여부 (미설정 시 테스트 발송으로 표기) */
  isLiveChannel: boolean;
  /** 데모(샘플) 데이터일 때는 상세 진입을 막는다. */
  readOnly?: boolean;
}

export function OrderBoard({ orders, isLiveChannel, readOnly = false }: OrderBoardProps) {
  const [activeFilter, setActiveFilter] = useState<OrderStatus | "all">("all");
  const [keyword, setKeyword] = useState("");

  const normalizedKeyword = keyword.trim().toLowerCase();

  const visibleOrders = orders.filter((order) => {
    const matchesStatus = activeFilter === "all" ? true : order.status === activeFilter;
    const matchesKeyword = normalizedKeyword
      ? order.orderNumber.toLowerCase().includes(normalizedKeyword) ||
        order.retailerName.toLowerCase().includes(normalizedKeyword)
      : true;

    return matchesStatus && matchesKeyword;
  });

  const countFor = (filter: OrderStatus | "all") =>
    filter === "all" ? orders.length : orders.filter((order) => order.status === filter).length;

  return (
    <section
      style={{
        backgroundColor: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        overflow: "hidden",
      }}
    >
      {/* 상태 필터 탭 */}
      <div
        style={{
          display: "flex",
          gap: "6px",
          padding: "12px",
          overflowX: "auto",
          borderBottom: "1px solid #e2e8f0",
        }}
      >
        {ORDER_STATUS_FILTERS.map((filter) => {
          const isSelected = activeFilter === filter;
          const label = filter === "all" ? "전체" : ORDER_STATUS_BADGES[filter].label;

          return (
            <button
              key={filter}
              type="button"
              onClick={() => setActiveFilter(filter)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "7px 13px",
                borderRadius: "20px",
                fontSize: "13px",
                fontWeight: isSelected ? 700 : 500,
                border: isSelected ? "1px solid #0f172a" : "1px solid #e2e8f0",
                backgroundColor: isSelected ? "#0f172a" : "#ffffff",
                color: isSelected ? "#ffffff" : "#475569",
                cursor: "pointer",
                whiteSpace: "nowrap",
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
                {countFor(filter)}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ padding: "12px", borderBottom: "1px solid #e2e8f0" }}>
        <input
          type="search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="주문번호 또는 발주처(바이어) 상호 검색"
          style={{
            width: "100%",
            padding: "8px 10px",
            fontSize: "13px",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
          }}
        />
      </div>

      {visibleOrders.length === 0 ? (
        <p style={{ padding: "40px 16px", textAlign: "center", fontSize: "13px", color: "#94a3b8" }}>
          조건에 맞는 발주서가 없습니다.
        </p>
      ) : (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>주문번호 / 접수일시</th>
                <th>발주처(바이어)</th>
                <th>발주 품목</th>
                <th>총 금액</th>
                <th>주문 상태</th>
                <th>알림톡 발송</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => {
                const badge = ORDER_STATUS_BADGES[order.status];
                const alimtalk = resolveAlimtalkStatus(order.status);

                return (
                  <tr key={order.id} style={{ opacity: order.status === "cancelled" ? 0.6 : 1 }}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 700 }}>{order.orderNumber}</div>
                      <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                        {formatOrderedAt(order.orderedAt)}
                      </div>
                    </td>

                    <td>
                      <div style={{ fontWeight: 600 }}>{order.retailerName}</div>
                      <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
                        {order.deliveryAddress}
                      </div>
                    </td>

                    <td style={{ fontSize: "12px", color: "#334155" }}>
                      {order.itemSummary}
                      <span style={{ color: "#94a3b8" }}> ({order.itemCount}개 품목)</span>
                    </td>

                    <td style={{ whiteSpace: "nowrap", fontWeight: 700 }}>
                      {formatWon(order.totalAmount)}
                    </td>

                    <td>
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          backgroundColor: badge.bg,
                          color: badge.color,
                          borderRadius: "4px",
                          padding: "4px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {badge.label}
                      </span>
                    </td>

                    <td>
                      <span
                        style={{
                          display: "inline-block",
                          fontSize: "11px",
                          fontWeight: 700,
                          backgroundColor: alimtalk.bg,
                          color: alimtalk.color,
                          borderRadius: "4px",
                          padding: "4px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        💬 {alimtalk.label}
                      </span>
                      <div style={{ fontSize: "10px", color: "#94a3b8", marginTop: "3px" }}>
                        {alimtalk.target} · {isLiveChannel ? "실발송" : "테스트 발송"}
                      </div>
                    </td>

                    <td>
                      {readOnly ? (
                        <span style={{ fontSize: "11px", color: "#94a3b8" }}>샘플</span>
                      ) : (
                        <Link
                          href={`/dashboard/orders/${order.id}`}
                          style={{
                            display: "inline-block",
                            fontSize: "12px",
                            fontWeight: 600,
                            padding: "5px 9px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            color: "#334155",
                            whiteSpace: "nowrap",
                          }}
                        >
                          상세 보기
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
