"use client";

import { useRef, useState, useTransition, type ChangeEvent } from "react";
import { decodeCsvFile, parseCsv } from "@/lib/utils/csv";
import { reconcileInvoicePaymentsAction } from "./actions";

export interface ReconcilableInvoice {
  id: string;
  businessName: string;
  amount: number;
}

interface BankTransaction {
  amount: number;
  memo: string;
  date: string | null;
}

interface MatchRow {
  transaction: BankTransaction;
  selectedInvoiceId: string | null;
  auto: boolean;
}

const AMOUNT_HEADER_CANDIDATES = ["입금액", "입금", "거래금액", "금액", "입금금액"];
const MEMO_HEADER_CANDIDATES = ["적요", "입금자명", "보낸분", "메모", "거래내용", "내용", "출금인"];
const DATE_HEADER_CANDIDATES = ["거래일시", "거래일자", "날짜", "거래일"];

function findHeaderIndex(header: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const index = header.findIndex((cell) => cell.trim().includes(candidate));

    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

function parseAmountCell(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.-]/g, "");

  if (!cleaned) {
    return null;
  }

  const value = Number(cleaned);

  return Number.isFinite(value) && value > 0 ? value : null;
}

interface BankReconcileUploaderProps {
  unpaidInvoices: ReconcilableInvoice[];
  onApplied: (matches: Array<{ invoiceId: string; note: string; paidAmount: number }>) => void;
}

/**
 * 은행에서 내려받은 입금 거래내역 CSV를 업로드해서 미납 청구서와 자동 대사(matching)하는
 * 도구. 완전 자동화(오픈뱅킹 API로 실시간 조회)는 별도 계약이 필요해 범위 밖이라, 관리자가
 * 수동으로 다운받은 CSV를 올리면 "금액 → 입금자명" 순으로 매칭해주고 애매한 건 화면에서
 * 직접 고르게 한다.
 */
export function BankReconcileUploader({ unpaidInvoices, onApplied }: BankReconcileUploaderProps) {
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setParseError(null);
    setApplyMessage(null);
    setMatches(null);

    const reader = new FileReader();

    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      const text = decodeCsvFile(buffer);
      const rows = parseCsv(text);

      if (rows.length < 2) {
        setParseError("파일에서 읽을 거래 내역이 없습니다.");
        return;
      }

      const header = rows[0];
      const amountIndex = findHeaderIndex(header, AMOUNT_HEADER_CANDIDATES);
      const memoIndex = findHeaderIndex(header, MEMO_HEADER_CANDIDATES);
      const dateIndex = findHeaderIndex(header, DATE_HEADER_CANDIDATES);

      if (amountIndex === -1) {
        setParseError('입금액 열을 찾지 못했습니다 — "입금액" 같은 이름의 열이 있는지 확인해주세요.');
        return;
      }

      const transactions: BankTransaction[] = [];

      for (const cells of rows.slice(1)) {
        const amount = parseAmountCell(cells[amountIndex] ?? "");

        if (amount === null) {
          continue;
        }

        transactions.push({
          amount,
          memo: memoIndex !== -1 ? (cells[memoIndex] ?? "").trim() : "",
          date: dateIndex !== -1 ? (cells[dateIndex] ?? "").trim() || null : null,
        });
      }

      if (transactions.length === 0) {
        setParseError("입금액이 있는 거래 행을 찾지 못했습니다(출금 내역만 있는 파일일 수 있습니다).");
        return;
      }

      // 이미 매칭된 청구서는 다음 거래의 후보에서 빼서 같은 청구서가 두 번 매칭되지 않게 한다.
      const remaining = new Map(unpaidInvoices.map((invoice) => [invoice.id, invoice]));

      const result: MatchRow[] = transactions.map((transaction) => {
        const byAmount = Array.from(remaining.values()).filter((invoice) => invoice.amount === transaction.amount);
        let picked: ReconcilableInvoice | null = null;

        if (byAmount.length === 1) {
          picked = byAmount[0];
        } else if (byAmount.length > 1 && transaction.memo) {
          const byName = byAmount.filter(
            (invoice) =>
              transaction.memo.includes(invoice.businessName) || invoice.businessName.includes(transaction.memo)
          );

          if (byName.length === 1) {
            picked = byName[0];
          }
        }

        if (picked) {
          remaining.delete(picked.id);
        }

        return { transaction, selectedInvoiceId: picked?.id ?? null, auto: Boolean(picked) };
      });

      setMatches(result);
    };

    reader.readAsArrayBuffer(file);
  };

  const handleApply = () => {
    if (!matches) {
      return;
    }

    const confirmed = matches.filter((match) => match.selectedInvoiceId);

    if (confirmed.length === 0) {
      setParseError("확정할 매칭이 없습니다.");
      return;
    }

    const payload = confirmed.map((match) => {
      const noteParts = [
        match.transaction.date ? `거래일 ${match.transaction.date}` : null,
        `입금액 ${match.transaction.amount.toLocaleString("ko-KR")}원`,
        match.transaction.memo ? `적요 "${match.transaction.memo}"` : null,
      ].filter((part): part is string => Boolean(part));

      return {
        invoiceId: match.selectedInvoiceId as string,
        note: `은행내역 대사 매칭 (${noteParts.join(" · ")})`,
        paidAmount: match.transaction.amount,
      };
    });

    startTransition(async () => {
      const result = await reconcileInvoicePaymentsAction(payload);

      if (!result.success || !result.data) {
        setParseError(result.error ?? "반영에 실패했습니다.");
        return;
      }

      onApplied(payload);
      setApplyMessage(
        `${result.data.updatedCount}건 완납 처리 완료${
          result.data.failedIds.length > 0 ? ` · 실패 ${result.data.failedIds.length}건` : ""
        }`
      );
      setMatches(null);
    });
  };

  const autoMatchedCount = matches?.filter((match) => match.auto).length ?? 0;
  const unmatchedCount = matches?.filter((match) => !match.selectedInvoiceId).length ?? 0;
  const hasSelection = matches?.some((match) => match.selectedInvoiceId) ?? false;

  return (
    <div
      style={{
        backgroundColor: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "8px",
        }}
      >
        <div>
          <div style={{ fontSize: "13px", fontWeight: 800, color: "#0f172a" }}>은행 거래내역 대사</div>
          <p style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
            은행에서 내려받은 입금 거래내역 CSV를 올리면 미납 청구서와 금액·입금자명으로 자동
            매칭합니다. 애매한 건은 직접 골라주세요.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            fontSize: "12px",
            fontWeight: 700,
            color: "#334155",
            backgroundColor: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            padding: "7px 12px",
            cursor: "pointer",
          }}
        >
          🏦 은행 거래내역 CSV 업로드
        </button>
        <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFile} style={{ display: "none" }} />
      </div>

      {parseError && (
        <p role="alert" style={{ fontSize: "12px", color: "#b91c1c", margin: 0 }}>
          {parseError}
        </p>
      )}
      {applyMessage && <p style={{ fontSize: "12px", color: "#166534", margin: 0 }}>✓ {applyMessage}</p>}

      {matches && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <p style={{ fontSize: "12px", color: "#334155", margin: 0 }}>
            거래 {matches.length}건 중 자동 매칭 <strong>{autoMatchedCount}건</strong>, 확인 필요{" "}
            <strong style={{ color: unmatchedCount > 0 ? "#dc2626" : undefined }}>{unmatchedCount}건</strong>
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "320px", overflowY: "auto" }}>
            {matches.map((match, index) => (
              <div
                key={index}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  flexWrap: "wrap",
                  backgroundColor: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "8px 10px",
                  fontSize: "12px",
                }}
              >
                <span style={{ color: "#64748b", minWidth: "90px" }}>{match.transaction.date ?? "-"}</span>
                <span style={{ fontWeight: 700, color: "#0f172a", minWidth: "90px" }}>
                  {match.transaction.amount.toLocaleString("ko-KR")}원
                </span>
                <span style={{ color: "#64748b", flex: 1, minWidth: "120px" }}>
                  {match.transaction.memo || "(적요 없음)"}
                </span>
                <select
                  value={match.selectedInvoiceId ?? ""}
                  onChange={(event) => {
                    const value = event.target.value || null;

                    setMatches((prev) =>
                      prev
                        ? prev.map((row, rowIndex) =>
                            rowIndex === index ? { ...row, selectedInvoiceId: value, auto: false } : row
                          )
                        : prev
                    );
                  }}
                  style={{
                    fontSize: "12px",
                    padding: "5px 8px",
                    borderRadius: "6px",
                    border: `1px solid ${match.selectedInvoiceId ? "#bbf7d0" : "#fecaca"}`,
                    backgroundColor: match.selectedInvoiceId ? "#f0fdf4" : "#fef2f2",
                    color: "#0f172a",
                    minWidth: "180px",
                  }}
                >
                  <option value="">매칭 안 함</option>
                  {unpaidInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.businessName} ({invoice.amount.toLocaleString("ko-KR")}원)
                    </option>
                  ))}
                </select>
                {match.selectedInvoiceId &&
                  (() => {
                    const invoice = unpaidInvoices.find((row) => row.id === match.selectedInvoiceId);

                    return invoice && invoice.amount !== match.transaction.amount ? (
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          color: "#92400e",
                          backgroundColor: "#fef3c7",
                          border: "1px solid #fde68a",
                          borderRadius: "6px",
                          padding: "2px 8px",
                        }}
                      >
                        ⚠ 청구액 {invoice.amount.toLocaleString("ko-KR")}원과 불일치
                      </span>
                    ) : null;
                  })()}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={handleApply}
            disabled={pending || !hasSelection}
            style={{
              alignSelf: "flex-start",
              fontSize: "12px",
              fontWeight: 700,
              color: "#ffffff",
              backgroundColor: pending || !hasSelection ? "#94a3b8" : "#0f172a",
              border: "none",
              borderRadius: "8px",
              padding: "8px 14px",
              cursor: pending || !hasSelection ? "not-allowed" : "pointer",
            }}
          >
            {pending ? "반영 중..." : "선택된 매칭 완납 처리"}
          </button>
        </div>
      )}
    </div>
  );
}
