"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatWon } from "@/lib/orders/status";
import {
  checkMovementEvidence,
  movementLabel,
  previewRepair,
  type MismatchRow,
  type MovementRow,
  type RepairBasis,
  type RepairHistoryRow,
} from "@/lib/supplier/stock-repair";
import { loadStockMovementsAction, repairStockMismatchAction } from "./actions";

const cardStyle = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "12px 14px",
} as const;

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${fmt(value)}`;
}

function formatAt(value: string): string {
  const date = new Date(value);

  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function RepairView({ mismatches, repairs }: { mismatches: MismatchRow[]; repairs: RepairHistoryRow[] }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [basis, setBasis] = useState<RepairBasis>("LEDGER");
  const [actualText, setActualText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [movements, setMovements] = useState<Record<string, MovementRow[] | "error">>({});
  const [pending, startTransition] = useTransition();

  const open = (row: MismatchRow) => {
    setError(null);
    setDone(null);

    if (openId === row.targetId) {
      setOpenId(null);
      return;
    }

    setOpenId(row.targetId);
    setBasis("LEDGER");
    setActualText("");
    setReason("");

    // 장부가 입출고와 맞는지 눈으로 확인할 수 있게 이 항목의 입출고 기록을 불러온다(한 번만).
    if (!movements[row.targetId]) {
      void loadStockMovementsAction(row.kind, row.targetId).then((result) => {
        setMovements((prev) => ({ ...prev, [row.targetId]: result.success && result.movements ? result.movements : "error" }));
      });
    }
  };

  const submit = (row: MismatchRow) => {
    const actual = actualText.trim() === "" ? null : Number(actualText);
    const preview = previewRepair(row, basis, actual);

    if (preview.error) {
      setError(preview.error);
      return;
    }

    if (reason.trim().length < 2) {
      setError("사유를 2자 이상 적어 주세요.");
      return;
    }

    setError(null);

    startTransition(async () => {
      const result = await repairStockMismatchAction({
        kind: row.kind,
        targetId: row.targetId,
        basis,
        actual,
        reason: reason.trim(),
        expectedCurrent: row.currentValue,
        expectedLedger: row.ledgerValue,
      });

      if (!result.success) {
        setError(result.error ?? "보정하지 못했습니다.");
        return;
      }

      setDone(`${row.label} — 보정했습니다.`);
      setOpenId(null);
      router.refresh();
    });
  };

  return (
    <>
      {done && (
        <p role="status" style={{ margin: 0, fontSize: "13px", fontWeight: 700, color: "#166534" }}>
          {done}
        </p>
      )}

      {mismatches.length === 0 ? (
        <section style={cardStyle}>
          <p style={{ margin: 0, fontSize: "13px", color: "#166534", fontWeight: 700 }}>어긋난 재고가 없습니다.</p>
          <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#64748b" }}>
            상품 재고와 박스 잔량이 모두 입출고 기록(장부)과 같습니다. 매일 자동으로 다시 점검해요.
          </p>
        </section>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {mismatches.map((row) => {
            const isOpen = openId === row.targetId;
            const actual = actualText.trim() === "" ? null : Number(actualText);
            const preview = isOpen ? previewRepair(row, basis, actual) : null;

            return (
              <section key={row.targetId} style={{ ...cardStyle, borderColor: isOpen ? "#93c5fd" : "#e2e8f0" }}>
                <div style={{ display: "flex", gap: "10px", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                      <span style={{ fontSize: "11px", color: "#475569", backgroundColor: "#f1f5f9", borderRadius: "6px", padding: "1px 6px", marginRight: "6px" }}>
                        {row.kind === "product" ? "상품 재고" : "박스 잔량"}
                      </span>
                      {row.label}
                    </div>
                    <div style={{ fontSize: "12px", color: "#64748b", marginTop: "3px" }}>
                      지금 {fmt(row.currentValue)}
                      {row.unit} · 장부 {fmt(row.ledgerValue)}
                      {row.unit} · 차이{" "}
                      <strong style={{ color: "#b45309" }}>
                        {signed(row.diff)}
                        {row.unit}
                      </strong>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => open(row)}
                    style={{ fontSize: "12px", fontWeight: 700, padding: "6px 14px", borderRadius: "999px", border: "1px solid #1d4ed8", backgroundColor: isOpen ? "#dbeafe" : "#ffffff", color: "#1d4ed8", cursor: "pointer" }}
                  >
                    {isOpen ? "닫기" : "고치기"}
                  </button>
                </div>

                {isOpen && preview && (
                  <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid #e2e8f0", paddingTop: "10px" }}>
                    <MovementPanel row={row} movements={movements[row.targetId]} />
                    <label style={{ fontSize: "13px", display: "flex", gap: "6px", alignItems: "flex-start" }}>
                      <input type="radio" name={`basis-${row.targetId}`} checked={basis === "LEDGER"} onChange={() => setBasis("LEDGER")} />
                      <span>
                        <strong>장부가 맞다</strong> — {row.kind === "product" ? "재고를" : "잔량을"} 장부 값({fmt(row.ledgerValue)}
                        {row.unit})에 맞춥니다. 입출고 기록은 그대로예요.
                      </span>
                    </label>
                    <label style={{ fontSize: "13px", display: "flex", gap: "6px", alignItems: "flex-start" }}>
                      <input type="radio" name={`basis-${row.targetId}`} checked={basis === "ACTUAL"} onChange={() => setBasis("ACTUAL")} />
                      <span>
                        <strong>실물이 맞다</strong> — 직접 세어 본 수량으로 맞춥니다. 장부에 그 차이만큼 보정 기록이 추가돼요.
                      </span>
                    </label>

                    {basis === "ACTUAL" && (
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.001"
                        min="0"
                        value={actualText}
                        onChange={(event) => setActualText(event.target.value)}
                        placeholder={`실물 수량(${row.unit})`}
                        aria-label="실물 수량"
                        style={{ fontSize: "13px", padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: "8px", maxWidth: "200px" }}
                      />
                    )}

                    <div style={{ fontSize: "12px", color: preview.error ? "#b91c1c" : "#334155", backgroundColor: "#f8fafc", borderRadius: "8px", padding: "8px 10px", lineHeight: 1.7 }}>
                      {preview.error ? (
                        preview.error
                      ) : (
                        <>
                          보정하면 {fmt(row.currentValue)}
                          {row.unit} → <strong>{fmt(preview.after ?? 0)}{row.unit}</strong>
                          {basis === "ACTUAL" && preview.ledgerChange !== 0 && (
                            <> · 장부에 {signed(preview.ledgerChange)}{row.unit} 보정 기록이 추가돼요</>
                          )}
                          {preview.valuationChange !== null && (
                            <>
                              <br />
                              재고 평가금액이{" "}
                              <strong style={{ color: preview.valuationChange < 0 ? "#b91c1c" : "#166534" }}>
                                {preview.valuationChange === 0 ? "변하지 않아요" : `약 ${formatWon(Math.abs(preview.valuationChange))} ${preview.valuationChange < 0 ? "줄어요" : "늘어요"}`}
                              </strong>
                              {basis === "ACTUAL" && preview.valuationChange < 0 && <> (손실로 볼 수 있어요)</>}
                            </>
                          )}
                          {row.kind === "product" && (
                            <>
                              <br />
                              <span style={{ color: "#64748b" }}>상품 단위 보정은 어느 박스인지 몰라 금액 영향은 계산하지 않아요.</span>
                            </>
                          )}
                        </>
                      )}
                    </div>

                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="사유 (예: 5월 3일 재고 실사에서 확인 / 입력 실수 확인)"
                      aria-label="사유"
                      rows={2}
                      maxLength={200}
                      style={{ fontSize: "13px", padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: "8px", resize: "vertical" }}
                    />

                    {error && (
                      <p role="alert" style={{ margin: 0, fontSize: "12px", color: "#b91c1c" }}>
                        {error}
                      </p>
                    )}

                    <div>
                      <button
                        type="button"
                        disabled={pending || Boolean(preview.error)}
                        onClick={() => submit(row)}
                        style={{ fontSize: "13px", fontWeight: 700, padding: "8px 18px", borderRadius: "8px", border: "none", backgroundColor: pending || preview.error ? "#cbd5e1" : "#1d4ed8", color: "#ffffff", cursor: pending || preview.error ? "not-allowed" : "pointer" }}
                      >
                        {pending ? "적용 중…" : "이대로 보정하기"}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <section style={{ ...cardStyle, padding: "8px 4px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", padding: "4px 12px 8px" }}>최근 보정 기록</div>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>대상</th>
                <th>기준</th>
                <th>전 → 후</th>
                <th>평가금액 영향</th>
                <th>사유 · 한 사람</th>
              </tr>
            </thead>
            <tbody>
              {repairs.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ color: "#64748b" }}>
                    아직 보정한 기록이 없습니다.
                  </td>
                </tr>
              )}
              {repairs.map((repair) => (
                <tr key={repair.id}>
                  <td>{formatAt(repair.createdAt)}</td>
                  <td style={{ fontWeight: 700 }}>
                    {repair.kind === "product" ? "상품 " : "박스 "}
                    {repair.targetLabel}
                  </td>
                  <td>{repair.basis === "LEDGER" ? "장부 기준" : "실물 기준"}</td>
                  <td>
                    {fmt(repair.beforeCurrent)} → {fmt(repair.afterValue)}
                  </td>
                  <td style={{ color: repair.valuationChange !== null && repair.valuationChange < 0 ? "#b91c1c" : undefined }}>
                    {repair.valuationChange === null ? "-" : `${repair.valuationChange > 0 ? "+" : ""}${formatWon(repair.valuationChange)}`}
                  </td>
                  <td>
                    {repair.reason} <span style={{ color: "#94a3b8" }}>· {repair.repairedByName}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function MovementPanel({ row, movements }: { row: MismatchRow; movements: MovementRow[] | "error" | undefined }) {
  if (movements === undefined) {
    return <div style={{ fontSize: "12px", color: "#64748b" }}>입출고 기록을 불러오는 중…</div>;
  }

  if (movements === "error") {
    return <div style={{ fontSize: "12px", color: "#b91c1c" }}>입출고 기록을 불러오지 못했어요. 새로 고친 뒤 다시 열어 주세요.</div>;
  }

  const evidence = checkMovementEvidence(row, movements);

  return (
    <div style={{ fontSize: "12px", color: "#334155" }}>
      <div style={{ fontWeight: 700, marginBottom: "4px" }}>
        이 {row.kind === "box" ? "박스" : "상품"}의 입출고 기록{" "}
        <span style={{ fontWeight: 400, color: "#64748b" }}>
          (더하면 장부 값 {fmt(row.ledgerValue)}
          {row.unit}이 돼요)
        </span>
      </div>

      {evidence.warnings.map((warning) => (
        <div
          key={warning}
          role="alert"
          style={{ color: "#92400e", backgroundColor: "#fffbeb", border: "1px solid #fde68a", borderRadius: "8px", padding: "6px 10px", marginBottom: "6px", lineHeight: 1.6 }}
        >
          ⚠️ {warning}
        </div>
      ))}

      {movements.length === 0 ? (
        <div style={{ color: "#64748b" }}>기록이 없습니다.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", maxHeight: "180px", overflowY: "auto" }}>
          {movements.map((movement, index) => (
            <div key={index} style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ color: "#64748b", minWidth: "78px" }}>{formatAt(movement.createdAt)}</span>
              <span style={{ minWidth: "150px" }}>{movementLabel(movement.eventType)}</span>
              <span style={{ fontWeight: 700, color: movement.qtyDelta < 0 ? "#b91c1c" : "#166534", minWidth: "70px" }}>
                {signed(movement.qtyDelta)}
                {row.unit}
              </span>
              <span style={{ color: "#64748b" }}>
                {movement.orderNumber ? `주문 ${movement.orderNumber}` : ""}
                {row.kind === "product" && movement.boxTraceNo ? ` 박스 ${movement.boxTraceNo}` : ""}
                {movement.reason ? ` · ${movement.reason}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {evidence.truncated && <div style={{ color: "#64748b", marginTop: "4px" }}>최근 100건만 보여줘서 합계 대조는 하지 않았어요.</div>}
    </div>
  );
}
