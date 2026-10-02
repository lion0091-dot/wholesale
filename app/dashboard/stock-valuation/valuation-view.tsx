"use client";

import { Fragment, useState, useTransition } from "react";
import { formatWon } from "@/lib/orders/status";
import type { ValuationBoxRow, ValuationSummary } from "@/lib/supplier/inventory-valuation";
import { loadValuationBoxesAction } from "./actions";

const cardStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "14px 16px",
} as const;

function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function SummaryCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div
      style={{
        ...cardStyle,
        flex: "1 1 160px",
        borderColor: tone === "warn" ? "#fde68a" : "#e2e8f0",
        backgroundColor: tone === "warn" ? "#fffbeb" : "#ffffff",
      }}
    >
      <div style={{ fontSize: "11px", color: "#64748b" }}>{label}</div>
      <div style={{ fontSize: "20px", fontWeight: 800, color: tone === "warn" ? "#92400e" : "#0f172a", marginTop: "2px" }}>{value}</div>
      {hint && <div style={{ fontSize: "11px", color: "#64748b", marginTop: "4px", lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );
}

export function ValuationView({ summary }: { summary: ValuationSummary }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Record<string, ValuationBoxRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (productId: string) => {
    setError(null);

    if (openId === productId) {
      setOpenId(null);
      return;
    }

    setOpenId(productId);

    if (boxes[productId]) return;

    startTransition(async () => {
      const result = await loadValuationBoxesAction(productId);

      if (!result.success || !result.boxes) {
        setError(result.error ?? "박스 목록을 불러오지 못했습니다.");
        return;
      }

      setBoxes((prev) => ({ ...prev, [productId]: result.boxes ?? [] }));
    });
  };

  if (summary.lines.length === 0) {
    return (
      <section style={cardStyle}>
        <p style={{ margin: 0, fontSize: "13px", color: "#475569" }}>
          지금 남아 있는 재고가 없습니다. 입고하면 여기에 원가로 얼마인지 나타납니다.
        </p>
      </section>
    );
  }

  return (
    <>
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <SummaryCard label="재고 평가금액(원가)" value={formatWon(summary.totalValue)} hint="남은 박스 kg × 박스마다의 매입단가" />
        <SummaryCard
          label="가장 오래된 박스"
          value={summary.oldestDays === null ? "-" : `${summary.oldestDays}일`}
          hint="입고한 날부터 센 날수예요"
        />
        <SummaryCard
          label="원가를 모르는 재고"
          value={`${formatQty(summary.unknownQty)}kg`}
          tone={summary.incomplete ? "warn" : undefined}
          hint={
            summary.incomplete
              ? "매입단가를 안 넣은 박스, 박스 없이 수동으로 넣은 재고예요. 평가금액에 빠져 있습니다."
              : "모든 재고의 원가를 압니다."
          }
        />
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: "12px", color: "#b91c1c" }}>
          {error}
        </p>
      )}

      <section style={{ ...cardStyle, padding: "8px 4px" }}>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>상품</th>
                <th>남은 재고</th>
                <th>평가금액</th>
                <th>평균 매입단가</th>
                <th>가장 오래된 박스</th>
              </tr>
            </thead>
            <tbody>
              {summary.lines.map((line) => {
                const open = openId === line.productId;

                return (
                  <Fragment key={line.productId}>
                    <tr onClick={() => toggle(line.productId)} style={{ cursor: "pointer" }}>
                      <td style={{ fontWeight: 700 }}>
                        {open ? "▾ " : "▸ "}
                        {line.productName}
                        {line.incomplete && (
                          <span style={{ fontSize: "11px", color: "#b45309", marginLeft: "6px" }}>
                            원가 미입력 {formatQty(line.unpricedQty + line.boxlessQty)}
                            {line.unit}
                          </span>
                        )}
                      </td>
                      <td>
                        {formatQty(line.remainingQty + line.boxlessQty)}
                        {line.unit} <span style={{ fontSize: "11px", color: "#94a3b8" }}>({line.boxCount}박스)</span>
                      </td>
                      <td style={{ fontWeight: 700 }}>{formatWon(line.valueAmount)}</td>
                      <td>{line.averageUnitCost === null ? "-" : `${formatWon(line.averageUnitCost)}/${line.unit}`}</td>
                      <td>{line.oldestDays === null ? "-" : `${line.oldestDays}일`}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={5} style={{ backgroundColor: "#f8fafc" }}>
                          {!boxes[line.productId] ? (
                            <span style={{ fontSize: "12px", color: "#64748b" }}>
                              {pending ? "박스 목록을 불러오는 중…" : "—"}
                            </span>
                          ) : (
                            <BoxList
                              rows={boxes[line.productId]}
                              unit={line.unit}
                              boxlessQty={line.boxlessQty}
                            />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function BoxList({ rows, unit, boxlessQty }: { rows: ValuationBoxRow[]; unit: string; boxlessQty: number }) {
  const total = rows[0]?.totalCount ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "4px 0" }}>
      <div style={{ fontSize: "11px", color: "#64748b" }}>오래된 박스부터 보여줍니다.</div>
      {rows.map((box) => {
        return (
          <div
            key={box.scanId}
            style={{ display: "flex", gap: "12px", flexWrap: "wrap", fontSize: "12px", color: "#334155", alignItems: "baseline" }}
          >
            <span style={{ fontWeight: 700, minWidth: "110px" }}>{box.traceNo}</span>
            <span>
              {formatQty(box.remainingWeight)}
              {unit}
            </span>
            <span>
              {box.unitPrice === null ? (
                <em style={{ color: "#b45309" }}>매입단가 없음</em>
              ) : (
                `${formatWon(box.unitPrice)}/${unit}`
              )}
            </span>
            <span style={{ fontWeight: 700 }}>{box.valueAmount === null ? "-" : formatWon(box.valueAmount)}</span>
            <span style={{ color: "#64748b" }}>입고 후 {box.daysOld}일</span>
            {box.bestBefore && <span style={{ color: "#64748b" }}>소비기한 {box.bestBefore}</span>}
          </div>
        );
      })}
      {total > rows.length && (
        <div style={{ fontSize: "11px", color: "#64748b" }}>
          박스가 {total}개라 오래된 {rows.length}개만 보여줍니다.
        </div>
      )}
      {boxlessQty > 0 && (
        <div style={{ fontSize: "11px", color: "#b45309" }}>
          박스 없이 수동으로 넣은 재고 {formatQty(boxlessQty)}
          {unit}는 매입단가를 몰라 평가금액에 빠져 있어요.
        </div>
      )}
    </div>
  );
}
