"use client";

import { useMemo, useState } from "react";
import { formatOrderedAt } from "@/lib/orders/status";
import { StatementPreviewButton } from "@/components/statement-preview-button";
import type { OrderRow } from "@/lib/orders/order-row";

export interface QuickDeliveryRequestRow extends OrderRow {
  /** DOCUMENT_LINK_SECRET 미설정 시 null — 그 경우 StatementPreviewButton이 기존 href로 폴백한다. */
  externalOpenHref: string | null;
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  backgroundColor: "#fff",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

export function QuickDeliveryRequestView({ rows }: { rows: QuickDeliveryRequestRow[] }) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) return rows;

    return rows.filter(
      (row) =>
        row.retailerName.toLowerCase().includes(query) || row.orderNumber.toLowerCase().includes(query)
    );
  }, [rows, search]);

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
          {rows.length === 0 ? "진행중 발주가 없습니다." : "검색 결과가 없습니다."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {filtered.map((row) => (
            <div key={row.id} style={cardStyle}>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>{row.retailerName}</div>
                <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                  {row.orderNumber} · {formatOrderedAt(row.orderedAt)}
                </div>
                <div style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                  {row.deliveryAddress}
                </div>
              </div>

              <StatementPreviewButton
                href={`/dashboard/orders/${row.id}/delivery-request`}
                label="배송의뢰서"
                externalOpenHref={row.externalOpenHref}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
