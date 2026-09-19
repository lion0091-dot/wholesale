"use client";

import { useRef, useState, useTransition } from "react";
import { AdminDateRangeFilter } from "@/components/admin-date-range-filter";
import { csvEscape, parseCsv } from "@/lib/utils/csv";
import { markInvoiceStatusAction, bulkUpdateInvoiceStatusAction } from "./actions";
import { BankReconcileUploader } from "./bank-reconcile-uploader";

export interface InvoiceRow {
  id: string;
  wholesalerId: string;
  businessName: string;
  businessNumber: string;
  /** 'YYYY-MM-DD' (그 달 1일) */
  billingMonth: string;
  billedRetailerCount: number;
  fullMonthFee: number;
  amount: number;
  status: "unpaid" | "paid";
  paidAt: string | null;
  collectedByName: string | null;
  memo: string | null;
  /** 실제 입금 확인된 금액. amount와 다르면 화면에서 불일치로 표시한다. 완납인데 null이면
   *  이 필드 도입 이전에 처리된 건이라 "수납액 미기록"으로 구분한다(불일치로 오인 금지). */
  paidAmount: number | null;
  /** 은행 거래내역 대사 도구가 후보로 들고 있었지만 매칭에 실패한 마지막 시각(미납일 때만 의미 있음). */
  lastReconcileAttemptedAt: string | null;
}

interface BillingInvoiceListProps {
  from: string;
  to: string;
  initialInvoices: InvoiceRow[];
}

const CSV_HEADERS = [
  "청구서ID",
  "공급사명",
  "사업자번호",
  "청구월",
  "실발주거래처수",
  "정가",
  "확정청구액",
  "상태",
  "수납액",
  "완납일",
  "처리자",
  "메모",
] as const;

function formatWon(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}

function formatMonth(billingMonth: string): string {
  const [year, month] = billingMonth.split("-");

  return `${year}년 ${Number(month)}월`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function buildCsv(rows: InvoiceRow[]): string {
  const lines = [CSV_HEADERS.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.businessName,
        row.businessNumber,
        formatMonth(row.billingMonth),
        String(row.billedRetailerCount),
        String(row.fullMonthFee),
        String(row.amount),
        row.status === "paid" ? "완납" : "미납",
        row.paidAmount !== null ? String(row.paidAmount) : "",
        row.paidAt ? formatDate(row.paidAt) : "",
        row.collectedByName ?? "",
        row.memo ?? "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  // Excel에서 한글이 깨지지 않도록 UTF-8 BOM을 붙인다.
  return `﻿${lines.join("\r\n")}`;
}

function parseStatusCell(raw: string): "paid" | "unpaid" | null {
  const normalized = raw.trim().toLowerCase();

  if (["완납", "paid", "y", "yes", "1", "true"].includes(normalized)) {
    return "paid";
  }
  if (["미납", "unpaid", "n", "no", "0", "false"].includes(normalized)) {
    return "unpaid";
  }

  return null;
}

export function BillingInvoiceList({ from, to, initialInvoices }: BillingInvoiceListProps) {
  const [invoices, setInvoices] = useState(initialInvoices);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // 완납 처리는 실제 입금액을 같이 받아야 해서 버튼 한 번에 끝나지 않는다 — 이 청구서
  // ID가 세팅되면 목록에 금액 입력 행이 인라인으로 펼쳐진다.
  const [payingId, setPayingId] = useState<string | null>(null);
  const [draftAmount, setDraftAmount] = useState("");
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalAmount = invoices.reduce((sum, row) => sum + row.amount, 0);
  const unpaidCount = invoices.filter((row) => row.status === "unpaid").length;

  const handleStartPaying = (invoice: InvoiceRow) => {
    setPayingId(invoice.id);
    setDraftAmount(String(invoice.amount));
  };

  const handleCancelPaying = () => {
    setPayingId(null);
    setDraftAmount("");
  };

  const handleConfirmPaid = (invoice: InvoiceRow) => {
    const amount = Number(draftAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      alert("실제 입금액을 올바르게 입력해주세요.");
      return;
    }

    setPendingId(invoice.id);

    startTransition(async () => {
      const result = await markInvoiceStatusAction(invoice.id, "paid", amount);
      setPendingId(null);

      if (!result.success) {
        alert(result.error ?? "처리에 실패했습니다.");
        return;
      }

      setInvoices((prev) =>
        prev.map((row) =>
          row.id === invoice.id
            ? {
                ...row,
                status: "paid",
                paidAt: new Date().toISOString(),
                collectedByName: "방금 처리함",
                paidAmount: amount,
              }
            : row
        )
      );
      setPayingId(null);
      setDraftAmount("");
    });
  };

  const handleRevertToUnpaid = (invoice: InvoiceRow) => {
    setPendingId(invoice.id);

    startTransition(async () => {
      const result = await markInvoiceStatusAction(invoice.id, "unpaid");
      setPendingId(null);

      if (!result.success) {
        alert(result.error ?? "처리에 실패했습니다.");
        return;
      }

      setInvoices((prev) =>
        prev.map((row) =>
          row.id === invoice.id
            ? { ...row, status: "unpaid", paidAt: null, collectedByName: null, paidAmount: null }
            : row
        )
      );
    });
  };

  const handleDownloadCsv = () => {
    const csv = buildCsv(invoices);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `구독료청구서_${from}_${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleUploadCsv = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setUploadMessage(null);
    setUploadError(null);

    const reader = new FileReader();

    reader.onload = () => {
      const text = String(reader.result ?? "");
      const rows = parseCsv(text);

      if (rows.length === 0) {
        setUploadError("파일에서 읽을 행이 없습니다.");
        return;
      }

      const header = rows[0];
      const idIndex = header.indexOf("청구서ID");
      const statusIndex = header.indexOf("상태");
      const paidAmountIndex = header.indexOf("수납액");

      if (idIndex === -1 || statusIndex === -1) {
        setUploadError('업로드 파일에 "청구서ID"와 "상태" 열이 모두 있어야 합니다(다운로드한 양식을 그대로 써주세요).');
        return;
      }

      const knownIds = new Set(invoices.map((row) => row.id));
      const updates: Array<{ invoiceId: string; status: "paid" | "unpaid"; paidAmount?: number }> = [];
      const skipped: string[] = [];

      for (const cells of rows.slice(1)) {
        const invoiceId = cells[idIndex]?.trim();
        const status = parseStatusCell(cells[statusIndex] ?? "");

        if (!invoiceId || !knownIds.has(invoiceId) || !status) {
          if (invoiceId) skipped.push(invoiceId);
          continue;
        }

        // "수납액" 열이 비어있으면 undefined로 둔다 — 서버 액션이 그 경우 paid_amount를
        // null(수납액 미기록)로 저장한다(청구액과 같다고 함부로 가정하지 않는다).
        const paidAmountRaw = paidAmountIndex !== -1 ? (cells[paidAmountIndex] ?? "").trim() : "";
        const paidAmount =
          status === "paid" && paidAmountRaw !== "" && Number.isFinite(Number(paidAmountRaw))
            ? Number(paidAmountRaw)
            : undefined;

        updates.push({ invoiceId, status, paidAmount });
      }

      if (updates.length === 0) {
        setUploadError("반영할 수 있는 행이 없습니다 — 청구서ID가 현재 조회 목록과 일치하는지 확인해주세요.");
        return;
      }

      startTransition(async () => {
        const result = await bulkUpdateInvoiceStatusAction(updates);

        if (!result.success || !result.data) {
          setUploadError(result.error ?? "일괄 반영에 실패했습니다.");
          return;
        }

        setInvoices((prev) =>
          prev.map((row) => {
            const match = updates.find((update) => update.invoiceId === row.id);

            if (!match) return row;

            return {
              ...row,
              status: match.status,
              paidAt: match.status === "paid" ? new Date().toISOString() : null,
              collectedByName: match.status === "paid" ? "엑셀 일괄 반영" : null,
              paidAmount: match.status === "paid" ? (match.paidAmount ?? null) : null,
            };
          })
        );

        setUploadMessage(
          `${result.data.updatedCount}건 반영 완료${skipped.length > 0 ? ` (일치하지 않는 ${skipped.length}건 제외)` : ""}${
            result.data.failedIds.length > 0 ? ` · 실패 ${result.data.failedIds.length}건` : ""
          }`
        );
      });
    };

    reader.readAsText(file, "utf-8");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <AdminDateRangeFilter basePath="/admin/billing" from={from} to={to} />

      <div
        style={{
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
          alignItems: "center",
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "12px 14px",
        }}
      >
        <span style={{ fontSize: "12px", color: "#334155" }}>
          조회 기간 합계 <strong>{formatWon(totalAmount)}</strong> · 미납 <strong style={{ color: "#dc2626" }}>{unpaidCount}건</strong>
        </span>

        <div style={{ marginLeft: "auto", display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleDownloadCsv}
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color: "#334155",
              backgroundColor: "#f1f5f9",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              padding: "7px 12px",
              cursor: "pointer",
            }}
          >
            📥 엑셀(CSV) 다운로드
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color: "#334155",
              backgroundColor: "#f1f5f9",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              padding: "7px 12px",
              cursor: "pointer",
            }}
          >
            📤 엑셀(CSV) 업로드로 수납 반영
          </button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleUploadCsv} style={{ display: "none" }} />
        </div>
      </div>

      {uploadMessage && (
        <p style={{ fontSize: "12px", color: "#166534", margin: 0 }}>✓ {uploadMessage}</p>
      )}
      {uploadError && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", margin: 0 }}>
          {uploadError}
        </p>
      )}

      <p style={{ fontSize: "11px", color: "#94a3b8", margin: 0 }}>
        업로드 파일은 다운로드한 CSV의 &quot;청구서ID&quot;·&quot;상태&quot;·&quot;수납액&quot; 열을 읽습니다(다른
        열은 참고용, 상태는 완납/미납으로 적어주세요) — 수납액을 비워두면 "수납액 미기록"으로
        저장되고, 청구액(확정청구액)과 다르게 적으면 화면에 불일치로 표시됩니다.
      </p>

      <BankReconcileUploader
        onApplied={(matches, unmatchedCandidateIds) => {
          const unmatchedSet = new Set(unmatchedCandidateIds);

          setInvoices((prev) =>
            prev.map((row) => {
              const match = matches.find((m) => m.invoiceId === row.id);

              if (match) {
                return {
                  ...row,
                  status: "paid",
                  paidAt: new Date().toISOString(),
                  collectedByName: "은행내역 대사",
                  memo: match.note,
                  paidAmount: match.paidAmount,
                  lastReconcileAttemptedAt: null,
                };
              }

              if (unmatchedSet.has(row.id)) {
                return { ...row, lastReconcileAttemptedAt: new Date().toISOString() };
              }

              return row;
            })
          );
        }}
      />

      {invoices.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#94a3b8" }}>선택한 기간에 확정된 청구서가 없습니다.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {invoices.map((invoice) => (
            <div
              key={invoice.id}
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "14px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                flexWrap: "wrap",
                gap: "10px",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>{invoice.businessName}</span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: "6px",
                      backgroundColor: invoice.status === "paid" ? "#dcfce7" : "#fee2e2",
                      color: invoice.status === "paid" ? "#166534" : "#991b1b",
                    }}
                  >
                    {invoice.status === "paid" ? "완납" : "미납"}
                  </span>
                </div>
                <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                  {formatMonth(invoice.billingMonth)} · 실발주 거래처 {invoice.billedRetailerCount}곳 ·{" "}
                  {invoice.businessNumber}
                </p>
                <p style={{ fontSize: "13px", color: "#334155", marginTop: "4px", fontWeight: 700 }}>
                  {formatWon(invoice.amount)}
                  {invoice.amount !== invoice.fullMonthFee && (
                    <span style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 400 }}>
                      {" "}
                      (정가 {formatWon(invoice.fullMonthFee)})
                    </span>
                  )}
                </p>
                {invoice.status === "paid" && (
                  <>
                    <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>
                      완납 처리: {invoice.collectedByName ?? "알 수 없음"}
                      {invoice.paidAt && ` · ${formatDate(invoice.paidAt)}`}
                    </p>
                    {invoice.paidAmount === null ? (
                      <p style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>수납액 미기록</p>
                    ) : invoice.paidAmount !== invoice.amount ? (
                      <p
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          color: "#92400e",
                          backgroundColor: "#fef3c7",
                          border: "1px solid #fde68a",
                          borderRadius: "6px",
                          padding: "3px 8px",
                          marginTop: "4px",
                          display: "inline-block",
                        }}
                      >
                        ⚠ 수납액 {formatWon(invoice.paidAmount)} — 청구액과 불일치
                      </p>
                    ) : (
                      <p style={{ fontSize: "11px", color: "#166534", marginTop: "2px" }}>
                        수납액 {formatWon(invoice.paidAmount)} (청구액과 일치)
                      </p>
                    )}
                  </>
                )}
                {invoice.status === "unpaid" && invoice.lastReconcileAttemptedAt && (
                  <p
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      color: "#9a3412",
                      backgroundColor: "#fff7ed",
                      border: "1px solid #fed7aa",
                      borderRadius: "6px",
                      padding: "3px 8px",
                      marginTop: "4px",
                      display: "inline-block",
                    }}
                  >
                    🔍 대사 시도함 — 매칭 실패 ({formatDate(invoice.lastReconcileAttemptedAt)})
                  </p>
                )}
              </div>

              {invoice.status === "paid" ? (
                <button
                  type="button"
                  onClick={() => handleRevertToUnpaid(invoice)}
                  disabled={pendingId === invoice.id}
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "#991b1b",
                    backgroundColor: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "6px",
                    padding: "7px 12px",
                    cursor: pendingId === invoice.id ? "wait" : "pointer",
                  }}
                >
                  {pendingId === invoice.id ? "처리 중..." : "미납으로 되돌리기"}
                </button>
              ) : payingId === invoice.id ? (
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <input
                    type="number"
                    value={draftAmount}
                    onChange={(event) => setDraftAmount(event.target.value)}
                    style={{
                      width: "110px",
                      fontSize: "12px",
                      padding: "6px 8px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                    }}
                    placeholder="실제 입금액"
                  />
                  <button
                    type="button"
                    onClick={() => handleConfirmPaid(invoice)}
                    disabled={pendingId === invoice.id}
                    style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      color: "#166534",
                      backgroundColor: "#f0fdf4",
                      border: "1px solid #bbf7d0",
                      borderRadius: "6px",
                      padding: "7px 10px",
                      cursor: pendingId === invoice.id ? "wait" : "pointer",
                    }}
                  >
                    {pendingId === invoice.id ? "처리 중..." : "확인"}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelPaying}
                    disabled={pendingId === invoice.id}
                    style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      color: "#64748b",
                      backgroundColor: "#f1f5f9",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      padding: "7px 10px",
                      cursor: "pointer",
                    }}
                  >
                    취소
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => handleStartPaying(invoice)}
                  style={{
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "#166534",
                    backgroundColor: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                    borderRadius: "6px",
                    padding: "7px 12px",
                    cursor: "pointer",
                  }}
                >
                  완납 처리
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
