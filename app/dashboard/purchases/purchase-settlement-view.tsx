"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatWon } from "@/lib/orders/status";
import {
  INBOUND_WEIGHT_TOLERANCE,
  evaluateWeightVariance,
  formatVarianceRatio,
  formatVarianceWeight,
} from "@/lib/livestock/weight-variance";
import { updateInboundPurchaseAction } from "./actions";

export interface PurchaseRow {
  scanId: string;
  scannedAt: string;
  traceNo: string;
  productId: string | null;
  productName: string | null;
  labeledWeight: number | null;
  actualWeight: number;
  weightVariance: number | null;
  varianceRatio: number | null;
  unitPrice: number | null;
  purchaseAmount: number | null;
  purchaseSupplier: string | null;
  status: string;
  scannedBy: string | null;
  /** 낙관적 동시성 체크용 — 이 값 그대로 저장 요청에 실어 보낸다. */
  updatedAt: string;
}

export interface PurchaseSummary {
  boxCount: number;
  labeledTotal: number;
  actualTotal: number;
  varianceTotal: number;
  purchaseTotal: number;
  unpricedCount: number;
  overGapCount: number;
  varianceAmount: number;
}

export interface PurchaseProduct {
  id: string;
  name: string;
}

interface Props {
  rows: PurchaseRow[];
  summary: PurchaseSummary;
  products: PurchaseProduct[];
  filters: { from: string; to: string; productId: string; supplier: string; onlyGap: boolean };
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PurchaseSettlementView({ rows, summary, products, filters }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [supplierInput, setSupplierInput] = useState(filters.supplier);
  const [editing, setEditing] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState("");
  const [supplierEdit, setSupplierEdit] = useState("");
  const [applyDefault, setApplyDefault] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 필터는 URL 쿼리로 유지한다 — 새로고침·뒤로가기에도 조건이 살아있고 링크로 공유된다. */
  const applyFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());

    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }

    router.push(`/dashboard/purchases?${params.toString()}`);
  };

  const startEdit = (row: PurchaseRow) => {
    setEditing(row.scanId);
    setPriceInput(row.unitPrice === null ? "" : String(row.unitPrice));
    setSupplierEdit(row.purchaseSupplier ?? "");
    setError(null);
  };

  const saveEdit = async (row: PurchaseRow) => {
    const unitPrice = Number.parseFloat(priceInput);

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setError("매입단가를 숫자로 입력해주세요.");
      return;
    }

    setBusy(true);

    const result = await updateInboundPurchaseAction({
      scanId: row.scanId,
      unitPrice,
      supplierName: supplierEdit.trim() || null,
      applyDefault,
      expectedUpdatedAt: row.updatedAt,
    });

    setBusy(false);

    if (!result.success) {
      setError(result.error ?? "저장에 실패했습니다.");
      // 충돌이면 내가 보던 값이 이미 낡은 것이다 — 편집을 닫고 최신값을 다시 불러온다.
      // (그냥 두면 다음 저장 시도도 또 같은 낡은 updatedAt으로 보내 계속 막힌다.)
      if (result.conflict) {
        setEditing(null);
        router.refresh();
      }
      return;
    }

    setEditing(null);
    router.refresh();
  };

  const cards = [
    { label: "박스", value: `${summary.boxCount}건`, accent: "#0f172a" },
    { label: "표기중량 합계", value: `${summary.labeledTotal}kg`, accent: "#475569" },
    { label: "실중량 합계", value: `${summary.actualTotal}kg`, accent: "#166534" },
    {
      label: "차이",
      value: `${formatVarianceWeight(summary.varianceTotal)}`,
      accent: summary.varianceTotal < 0 ? "#991b1b" : "#475569",
    },
    { label: "매입금액", value: formatWon(summary.purchaseTotal), accent: "#1e40af" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <section style={panelStyle}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {cards.map((card) => (
            <div key={card.label} style={{ flex: "1 1 130px", minWidth: 0 }}>
              <div style={{ fontSize: "11px", color: "#94a3b8" }}>{card.label}</div>
              <div style={{ fontSize: "16px", fontWeight: 800, color: card.accent }}>{card.value}</div>
            </div>
          ))}
        </div>

        {(summary.unpricedCount > 0 || summary.overGapCount > 0) && (
          <div
            style={{
              marginTop: "10px",
              display: "flex",
              gap: "8px",
              flexWrap: "wrap",
              fontSize: "12px",
            }}
          >
            {summary.unpricedCount > 0 && (
              <span style={{ ...chipStyle, backgroundColor: "#fef3c7", color: "#92400e" }}>
                단가 미입력 {summary.unpricedCount}건 — 매입금액 합계는 아직 미완성입니다
              </span>
            )}
            {summary.overGapCount > 0 && (
              <span style={{ ...chipStyle, backgroundColor: "#fee2e2", color: "#991b1b" }}>
                오차 초과 {summary.overGapCount}건 · 차액 {formatWon(summary.varianceAmount)}
              </span>
            )}
          </div>
        )}
      </section>

      <section style={panelStyle}>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ width: "140px" }}>
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

          <div style={{ width: "140px" }}>
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

          <div style={{ flex: "1 1 180px", minWidth: 0 }}>
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

          <div style={{ flex: "1 1 150px", minWidth: 0 }}>
            <label htmlFor="supplier" style={labelStyle}>
              매입처
            </label>
            <input
              id="supplier"
              value={supplierInput}
              onChange={(event) => setSupplierInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  applyFilter("supplier", supplierInput.trim());
                }
              }}
              placeholder="일부만 입력해도 됩니다"
              style={inputStyle}
            />
          </div>

          <button type="button" onClick={() => applyFilter("supplier", supplierInput.trim())} style={searchButtonStyle}>
            검색
          </button>

          <button
            type="button"
            onClick={() => applyFilter("gap", filters.onlyGap ? "" : "1")}
            style={{
              ...searchButtonStyle,
              ...(filters.onlyGap ? { backgroundColor: "#0f172a", color: "#fff", borderColor: "#0f172a" } : {}),
            }}
          >
            오차 초과만 (±{Math.round(INBOUND_WEIGHT_TOLERANCE * 100)}% 초과)
          </button>
        </div>
      </section>

      {error && (
        <div
          style={{
            border: "1px solid #fecaca",
            backgroundColor: "#fee2e2",
            color: "#991b1b",
            borderRadius: "8px",
            padding: "10px 12px",
            fontSize: "13px",
          }}
        >
          {error}
        </div>
      )}

      <section style={panelStyle}>
        {rows.length === 0 ? (
          <p style={{ fontSize: "13px", color: "#94a3b8", margin: 0 }}>
            조건에 맞는 입고 기록이 없습니다.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {rows.map((row) => {
              const variance = evaluateWeightVariance(row.labeledWeight, row.actualWeight);
              const isEditing = editing === row.scanId;

              return (
                <div key={row.scanId} style={rowStyle}>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "11px", color: "#94a3b8" }}>{formatDateTime(row.scannedAt)}</span>
                    <span style={{ fontFamily: "monospace", fontSize: "13px" }}>{row.traceNo}</span>
                    <span style={{ fontWeight: 600 }}>{row.productName ?? "상품 미지정"}</span>

                    <span style={{ fontSize: "12px", color: "#475569" }}>
                      표기 {row.labeledWeight === null ? "-" : `${row.labeledWeight}kg`} → 실측{" "}
                      <strong>{row.actualWeight}kg</strong>
                    </span>

                    {variance && (
                      <span
                        style={{
                          ...chipStyle,
                          ...(variance.exceeded
                            ? { backgroundColor: "#fee2e2", color: "#991b1b" }
                            : { backgroundColor: "#f1f5f9", color: "#64748b" }),
                        }}
                      >
                        {formatVarianceWeight(variance.variance)} ({formatVarianceRatio(variance.ratio)})
                      </span>
                    )}

                    {row.purchaseSupplier && (
                      <span style={{ fontSize: "12px", color: "#64748b" }}>{row.purchaseSupplier}</span>
                    )}
                  </div>

                  {isEditing ? (
                    <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                      <input
                        type="number"
                        min="0"
                        step="100"
                        value={priceInput}
                        onChange={(event) => setPriceInput(event.target.value)}
                        placeholder="원/kg"
                        aria-label="매입단가"
                        style={{ ...inputStyle, width: "110px" }}
                      />
                      <input
                        value={supplierEdit}
                        onChange={(event) => setSupplierEdit(event.target.value)}
                        placeholder="매입처"
                        aria-label="매입처"
                        style={{ ...inputStyle, width: "120px" }}
                      />
                      <label style={{ fontSize: "12px", color: "#475569", display: "flex", gap: "4px" }}>
                        <input
                          type="checkbox"
                          checked={applyDefault}
                          onChange={(event) => setApplyDefault(event.target.checked)}
                        />
                        이 상품 기본단가로
                      </label>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void saveEdit(row)}
                        style={{ ...searchButtonStyle, backgroundColor: "#0f172a", color: "#fff", borderColor: "#0f172a" }}
                      >
                        저장
                      </button>
                      <button type="button" onClick={() => setEditing(null)} style={searchButtonStyle}>
                        취소
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <span style={{ fontSize: "12px", color: "#64748b" }}>
                        {row.unitPrice === null ? "단가 없음" : `${formatWon(row.unitPrice)}/kg`}
                      </span>
                      <span style={{ fontWeight: 800, color: row.purchaseAmount === null ? "#94a3b8" : "#1e40af" }}>
                        {row.purchaseAmount === null ? "금액 미정" : formatWon(row.purchaseAmount)}
                      </span>
                      <button type="button" onClick={() => startEdit(row)} style={searchButtonStyle}>
                        단가 입력
                      </button>
                    </div>
                  )}
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

const chipStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  borderRadius: "4px",
  padding: "3px 7px",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
  flexWrap: "wrap",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "10px 12px",
  fontSize: "13px",
  color: "#0f172a",
};
