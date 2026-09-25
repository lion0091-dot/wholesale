"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LEDGER_EVENTS, ledgerEventMeta } from "@/lib/stock/ledger-events";

export interface LedgerRow {
  id: string;
  createdAt: string;
  eventType: string;
  qtyDelta: number;
  /** 이 일이 일어난 직후의 해당 상품 재고 */
  balanceAfter: number;
  reason: string | null;
  productName: string | null;
  productUnit: string;
  traceNo: string | null;
  orderNumber: string | null;
  actorName: string | null;
}

export interface LedgerSummary {
  inbound: number;
  outbound: number;
  adjustment: number;
  loss: number;
}

export interface LedgerProduct {
  id: string;
  name: string;
}

interface Props {
  rows: LedgerRow[];
  summary: LedgerSummary;
  products: LedgerProduct[];
  totalCount: number;
  filters: { from: string; to: string; productId: string; eventType: string; traceNo: string };
}

function formatQty(value: number, unit: string): string {
  const sign = value > 0 ? "+" : "";

  return `${sign}${value}${unit}`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function StockLedgerView({ rows, summary, products, totalCount, filters }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 이력번호는 타자마다 주소를 바꾸면 깜빡이므로 Enter(또는 검색 버튼)로만 적용한다.
  const [traceInput, setTraceInput] = useState(filters.traceNo);

  useEffect(() => {
    setTraceInput(filters.traceNo);
  }, [filters.traceNo]);

  /** 필터는 URL 쿼리로 유지한다 — 새로고침·뒤로가기에도 조건이 살아있고 링크로 공유된다. */
  const applyFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());

    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }

    router.push(`/dashboard/stock-ledger?${params.toString()}`);
  };

  const cards = [
    { label: "입고", value: summary.inbound, accent: "#166534" },
    { label: "출고", value: summary.outbound, accent: "#1e40af" },
    { label: "조정", value: summary.adjustment, accent: "#92400e" },
    { label: "손실", value: summary.loss, accent: "#991b1b" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <section style={panelStyle}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label htmlFor="from" style={labelStyle}>
              시작일
            </label>
            <input
              id="from"
              type="date"
              value={filters.from}
              onChange={(event) => applyFilter("from", event.target.value)}
              style={inputStyle}
            />
          </div>

          <div>
            <label htmlFor="to" style={labelStyle}>
              종료일
            </label>
            <input
              id="to"
              type="date"
              value={filters.to}
              onChange={(event) => applyFilter("to", event.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={{ minWidth: "160px" }}>
            <label htmlFor="product" style={labelStyle}>
              상품
            </label>
            <select
              id="product"
              value={filters.productId}
              onChange={(event) => applyFilter("product", event.target.value)}
              style={inputStyle}
            >
              <option value="">전체</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ flex: "1 1 180px", minWidth: "160px" }}>
            <label htmlFor="trace" style={labelStyle}>
              이력번호
            </label>
            <div style={{ display: "flex", gap: "4px" }}>
              <input
                id="trace"
                value={traceInput}
                onChange={(event) => setTraceInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyFilter("trace", traceInput.trim());
                  }
                }}
                placeholder="번호 일부만 입력해도 됩니다"
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => applyFilter("trace", traceInput.trim())}
                style={searchButtonStyle}
              >
                검색
              </button>
              {filters.traceNo && (
                <button
                  type="button"
                  onClick={() => {
                    setTraceInput("");
                    applyFilter("trace", "");
                  }}
                  style={{ ...searchButtonStyle, color: "#b91c1c", borderColor: "#fecaca" }}
                  aria-label="이력번호 검색 지우기"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div style={{ minWidth: "120px" }}>
            <label htmlFor="event" style={labelStyle}>
              유형
            </label>
            <select
              id="event"
              value={filters.eventType}
              onChange={(event) => applyFilter("event", event.target.value)}
              style={inputStyle}
            >
              <option value="">전체</option>
              {LEDGER_EVENTS.map((event) => (
                <option key={event.code} value={event.code}>
                  {event.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "10px" }}>
        {cards.map((card) => (
          <div key={card.label} style={{ ...panelStyle, padding: "12px 14px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>{card.label}</div>
            <div style={{ fontSize: "18px", fontWeight: 800, color: card.accent, marginTop: "4px" }}>
              {card.value > 0 ? "+" : ""}
              {Math.round(card.value * 100) / 100}
            </div>
          </div>
        ))}
      </section>

      <section style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>
          내역{" "}
          <span style={{ color: "#94a3b8", fontWeight: 400 }}>
            {totalCount > rows.length ? `${rows.length} / 총 ${totalCount}건` : `${rows.length}건`}
          </span>
        </div>

        {rows.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>
            이 조건에 해당하는 내역이 없습니다.
            {filters.traceNo ? " 이력번호는 기간 안에 있는 건만 찾습니다 — 기간을 넓혀보세요." : ""}
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {rows.map((row) => {
              const meta = ledgerEventMeta(row.eventType);

              return (
                <div key={row.id} style={rowStyle}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                    <span style={{ fontSize: "11px", color: "#94a3b8", whiteSpace: "nowrap" }}>
                      {formatDateTime(row.createdAt)}
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        backgroundColor: meta.bg,
                        color: meta.color,
                        borderRadius: "4px",
                        padding: "3px 7px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {meta.label}
                    </span>
                    <span style={{ fontWeight: 600 }}>{row.productName ?? "삭제된 상품"}</span>
                    {row.traceNo && (
                      <span style={{ fontFamily: "monospace", fontSize: "12px", color: "#64748b" }}>
                        {row.traceNo}
                      </span>
                    )}
                    {row.orderNumber && (
                      <span style={{ fontSize: "12px", color: "#64748b" }}>{row.orderNumber}</span>
                    )}
                    {row.reason && <span style={{ fontSize: "12px", color: "#94a3b8" }}>{row.reason}</span>}
                  </div>

                  <div style={{ display: "flex", gap: "10px", alignItems: "center", whiteSpace: "nowrap" }}>
                    {row.actorName && (
                      <span style={{ fontSize: "11px", color: "#cbd5e1" }}>{row.actorName}</span>
                    )}
                    <span
                      style={{
                        fontWeight: 700,
                        color: row.qtyDelta > 0 ? "#166534" : "#991b1b",
                      }}
                    >
                      {formatQty(row.qtyDelta, row.productUnit)}
                    </span>
                    {/* 이 줄까지 반영된 재고 — 숫자가 왜 이렇게 됐는지 따라 읽는 용도다. */}
                    <span
                      style={{ fontSize: "12px", color: "#475569", minWidth: "72px", textAlign: "right" }}
                      title="이 일이 일어난 직후 재고"
                    >
                      → {Math.round(row.balanceAfter * 100) / 100}
                      {row.productUnit}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "10px",
  backgroundColor: "#fff",
  padding: "14px",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "#475569",
  marginBottom: "4px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "13px",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  backgroundColor: "#fff",
};

const searchButtonStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "13px",
  fontWeight: 600,
  borderRadius: "6px",
  border: "1px solid #e2e8f0",
  backgroundColor: "#f8fafc",
  color: "#334155",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
  flexWrap: "wrap",
  borderBottom: "1px solid #f1f5f9",
  paddingBottom: "8px",
};
