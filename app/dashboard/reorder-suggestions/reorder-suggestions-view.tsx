"use client";

import Link from "next/link";

export interface SuggestionRow {
  productId: string;
  productName: string;
  category: string | null;
  unit: string;
  stockQuantity: number;
  avgDailyOutbound: number;
  daysLeft: number;
}

interface Props {
  rows: SuggestionRow[];
}

function formatQty(value: number, unit: string): string {
  return `${value.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}${unit}`;
}

function urgency(daysLeft: number): { label: string; bg: string; color: string } {
  if (daysLeft < 3) return { label: "매우 급함", bg: "#fee2e2", color: "#991b1b" };
  if (daysLeft < 7) return { label: "급함", bg: "#fef3c7", color: "#92400e" };

  return { label: "여유 있음", bg: "#e2e8f0", color: "#475569" };
}

const panelStyle: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: "12px", backgroundColor: "#fff", padding: "14px" };
const rowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "10px",
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  fontSize: "13px",
};

export function ReorderSuggestionsView({ rows }: Props) {
  return (
    <section style={panelStyle}>
      <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
        발주가 필요할 수 있는 상품 ({rows.length}개)
      </div>

      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: "13px", color: "#94a3b8" }}>
          최근 판매 흐름이 있는 상품 중에는 지금 급하게 발주할 것이 없습니다.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {rows.map((row) => {
            const badge = urgency(row.daysLeft);

            return (
              <div key={row.productId} style={rowStyle}>
                {row.category && (
                  <span style={{ fontSize: "11px", fontWeight: 700, color: "#64748b" }}>[{row.category}]</span>
                )}
                <span style={{ fontWeight: 700 }}>{row.productName}</span>
                <span
                  style={{ fontSize: "11px", fontWeight: 700, backgroundColor: badge.bg, color: badge.color, borderRadius: "4px", padding: "2px 8px" }}
                >
                  {badge.label}
                </span>
                <span style={{ color: "#334155" }}>현재 재고 {formatQty(row.stockQuantity, row.unit)}</span>
                <span style={{ color: "#64748b" }}>최근 하루 평균 {formatQty(row.avgDailyOutbound, row.unit)} 판매</span>
                <span style={{ fontWeight: 700, color: "#0f172a" }}>약 {row.daysLeft.toFixed(1)}일 남음</span>

                <Link
                  href="/dashboard/purchase-orders"
                  style={{ marginLeft: "auto", fontSize: "12px", fontWeight: 700, color: "#1d4ed8", textDecoration: "none" }}
                >
                  발주서 작성하러 가기 →
                </Link>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ margin: "12px 0 0", fontSize: "12px", color: "#94a3b8" }}>
        재고 수량을 최근 판매 속도로 나눠서 계산한 참고용 예측입니다. 명절·행사처럼 갑자기 잘 팔린 날이 있으면
        숫자가 실제보다 급하게 나올 수 있습니다.
      </p>
    </section>
  );
}
