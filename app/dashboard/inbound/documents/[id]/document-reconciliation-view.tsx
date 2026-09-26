"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  closeInboundDocumentAction,
  getDocumentFileUrlAction,
  linkScanToDocumentLineAction,
  reopenInboundDocumentAction,
  unlinkScanFromDocumentLineAction,
} from "../../document-actions";
import { resolveMappingAction } from "../../actions";
import type { ScanProductOption } from "../../inbound-scan-view";
import { InboundTabs } from "../../../section-tabs";

/**
 * 29단계 B — 명세서 ↔ 실물 박스 사무실 대조 화면.
 *
 * 잠긴 결정(docs/inbound-document-reconciliation-spec.md §1): 재고는 스캔이 만든다 — 여기서
 * 하는 붙이기/떼기는 대조·집계용이고 재고 원장과 무관하다. 애매한 배정은 전부 여기서, 자동은
 * 후보가 하나일 때만(현장에서 이미 붙은 것들이다).
 */

export type LineMatchStatus = "AWAITING" | "PARTIAL" | "COMPLETE" | "OVER";
export type ScanStatus = "NORMAL" | "PENDING_MAPPING" | "EXCEPTION" | "VOIDED";

export interface ReconciliationLineBox {
  scanId: string;
  traceNo: string;
  weight: number;
  status: ScanStatus;
  linkedHow: "AUTO" | "MANUAL";
  linkedAt: string;
  createdAt: string;
}

export interface ReconciliationLine {
  id: string;
  lineNo: number;
  itemName: string | null;
  productId: string | null;
  productName: string | null;
  partName: string | null;
  grade: string | null;
  origin: string | null;
  traceNo: string | null;
  lotNo: string | null;
  expected: number;
  linked: number;
  status: LineMatchStatus;
  labeledWeight: number | null;
  /** raw_text의 "(이력번호 k/N)"에서 k>1 — 표기중량은 첫 줄 합계에 포함된 것. */
  isSplitContinuation: boolean;
  boxes: ReconciliationLineBox[];
}

export interface UnlinkedBoxCandidate {
  lineId: string;
  /** NUMBER: 번호로 확정된 후보. SUGGESTED: 축종+중량 제안. SUGGESTED_UNCONFIRMED: 중량만(축종 모름). */
  basis: "NUMBER" | "SUGGESTED" | "SUGGESTED_UNCONFIRMED";
}

export interface UnlinkedBox {
  scanId: string;
  traceNo: string;
  weight: number;
  status: "NORMAL" | "PENDING_MAPPING" | "EXCEPTION";
  productId: string | null;
  createdAt: string;
  candidates: UnlinkedBoxCandidate[];
}

export interface DocumentReconciliationViewProps {
  documentId: string;
  supplierName: string | null;
  documentNo: string | null;
  issuedOn: string | null;
  status: "PENDING" | "CLOSED";
  note: string | null;
  hasFile: boolean;
  lines: ReconciliationLine[];
  unlinkedBoxes: UnlinkedBox[];
  rangeFrom: string;
  rangeTo: string;
  products: ScanProductOption[];
}

const STATUS_BADGE: Record<LineMatchStatus, { label: string; bg: string; color: string }> = {
  AWAITING: { label: "아직 안 옴", bg: "#f1f5f9", color: "#64748b" },
  PARTIAL: { label: "일부만 옴", bg: "#fef3c7", color: "#92400e" },
  COMPLETE: { label: "다 옴", bg: "#dcfce7", color: "#166534" },
  OVER: { label: "더 많이 옴", bg: "#fee2e2", color: "#991b1b" },
};

const SCAN_STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  NORMAL: { label: "정상", bg: "#dcfce7", color: "#166534" },
  PENDING_MAPPING: { label: "상품 확인 필요", bg: "#fef3c7", color: "#92400e" },
  EXCEPTION: { label: "이력 못 찾음", bg: "#fee2e2", color: "#991b1b" },
};

function formatWeight(weight: number): string {
  return `${weight}kg`;
}

function lineLabel(line: ReconciliationLine): string {
  return line.itemName || line.productName || `${line.lineNo}번 줄`;
}

export function DocumentReconciliationView({
  documentId,
  supplierName,
  documentNo,
  issuedOn,
  status,
  note,
  hasFile,
  lines,
  unlinkedBoxes,
  rangeFrom,
  rangeTo,
  products,
}: DocumentReconciliationViewProps) {
  const router = useRouter();
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fromInput, setFromInput] = useState(rangeFrom);
  const [toInput, setToInput] = useState(rangeTo);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [closeNote, setCloseNote] = useState("");
  const [closing, setClosing] = useState(false);
  // 평소엔 볼 일이 없다 — 명세서와 맞아 보이는 박스가 있을 때만 처음부터 펼친다.
  const [showUnlinked, setShowUnlinked] = useState(unlinkedBoxes.some((box) => box.candidates.length > 0));

  const isPending = status === "PENDING";
  const lineById = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);

  const summary = useMemo(() => {
    const counts = { AWAITING: 0, PARTIAL: 0, COMPLETE: 0, OVER: 0 } as Record<LineMatchStatus, number>;
    let labeledTotal = 0;
    let actualTotal = 0;

    lines.forEach((line) => {
      counts[line.status] += 1;

      if (!line.isSplitContinuation && line.labeledWeight !== null) {
        labeledTotal += line.labeledWeight;
      }

      actualTotal += line.boxes.reduce((sum, box) => sum + box.weight, 0);
    });

    return { counts, labeledTotal, actualTotal, diff: actualTotal - labeledTotal };
  }, [lines]);

  const incompleteLines = lines.filter((line) => line.status !== "COMPLETE");
  const matchableUnlinkedCount = unlinkedBoxes.filter((box) => box.candidates.length > 0).length;

  const runAction = async (key: string, run: () => Promise<{ success: boolean; error?: string }>) => {
    setBusyKey(key);
    setError(null);

    const result = await run();

    setBusyKey(null);

    if (!result.success) {
      setError(result.error ?? "처리하지 못했습니다.");
      return false;
    }

    setNotice(null);
    router.refresh();
    return true;
  };

  const handleLinkCandidate = async (scanId: string, lineId: string, box: UnlinkedBox) => {
    const key = `link-${scanId}-${lineId}`;
    const ok = await runAction(key, () => linkScanToDocumentLineAction(scanId, lineId));

    if (!ok) return;

    const line = lineById.get(lineId);

    // 박스는 상품 미확정인데 그 줄엔 상품이 지정돼 있으면, 그 줄 상품으로 확정할지 물어본다(스펙 3.3-5).
    if (line?.productId && box.productId === null) {
      if (window.confirm(`이 박스를 "${line.productName ?? line.itemName}" 상품으로 지정할까요?`)) {
        await runAction(`resolve-${scanId}`, async () => resolveMappingAction(scanId, line.productId!, true));
      }
    }
  };

  const handleUnlink = async (scanId: string) => {
    await runAction(`unlink-${scanId}`, () => unlinkScanFromDocumentLineAction(scanId));
  };

  const handleResolveProduct = async (scanId: string, productId: string) => {
    if (!productId) return;
    await runAction(`resolve-${scanId}`, async () => resolveMappingAction(scanId, productId, true));
  };

  const handleOpenFile = async () => {
    setBusyKey("file");
    const result = await getDocumentFileUrlAction(documentId);

    setBusyKey(null);

    if (result.success && result.data) {
      window.open(result.data, "_blank", "noopener");
    } else {
      setError(result.error ?? "원본을 열지 못했습니다.");
    }
  };

  const handleClose = async () => {
    setClosing(true);
    setError(null);

    const result = await closeInboundDocumentAction(documentId, closeNote || null);

    setClosing(false);

    if (!result.success) {
      setError(result.error ?? "마감하지 못했습니다.");
      return;
    }

    setCloseModalOpen(false);
    setCloseNote("");
    setNotice("마감했습니다.");
    router.refresh();
  };

  const handleReopen = async () => {
    await runAction("reopen", () => reopenInboundDocumentAction(documentId));
  };

  const applyRange = () => {
    const params = new URLSearchParams();

    if (fromInput) params.set("from", fromInput);
    if (toInput) params.set("to", toInput);
    router.push(`/dashboard/inbound/documents/${documentId}?${params.toString()}`);
  };

  const copySupplierRequest = () => {
    const text =
      `[${supplierName ?? "공급처"}] 명세서 대조 — 미입고 확인 요청\n` +
      incompleteLines
        .map((line) => `- ${lineLabel(line)} (예정 ${line.expected} / 입고 ${line.linked})`)
        .join("\n");

    void navigator.clipboard.writeText(text);
    setNotice("문구를 복사했습니다.");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <InboundTabs />

      <header style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <Link href="/dashboard/inbound/statements" style={{ fontSize: "12px", color: "#64748b" }}>
          ← 전표입력으로
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>
            {supplierName ?? "공급처 미입력"}
          </h1>
          <span
            style={{
              fontSize: "12px",
              fontWeight: 700,
              backgroundColor: isPending ? "#dbeafe" : "#e2e8f0",
              color: isPending ? "#1e40af" : "#475569",
              borderRadius: "6px",
              padding: "4px 9px",
            }}
          >
            {isPending ? "대조 중" : "마감"}
          </span>
        </div>

        <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>
          {issuedOn ?? "서류 날짜 미상"}
          {documentNo ? ` · ${documentNo}` : ""}
        </p>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {hasFile && (
            <button type="button" onClick={handleOpenFile} disabled={busyKey === "file"} style={secondaryButton}>
              원본 보기
            </button>
          )}
          {isPending ? (
            <button type="button" onClick={() => setCloseModalOpen(true)} style={primaryButton}>
              마감
            </button>
          ) : (
            <button type="button" onClick={handleReopen} disabled={busyKey === "reopen"} style={secondaryButton}>
              다시 열기
            </button>
          )}
        </div>

        {note && (
          <div
            style={{
              backgroundColor: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "8px 12px",
              fontSize: "12px",
              color: "#475569",
              whiteSpace: "pre-wrap",
            }}
          >
            {note}
          </div>
        )}
      </header>

      {error && (
        <p
          style={{
            margin: 0,
            padding: "10px 12px",
            fontSize: "13px",
            color: "#991b1b",
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "8px",
          }}
        >
          {error}
        </p>
      )}

      {notice && (
        <p
          style={{
            margin: 0,
            padding: "10px 12px",
            fontSize: "13px",
            color: "#065f46",
            backgroundColor: "#ecfdf5",
            border: "1px solid #a7f3d0",
            borderRadius: "8px",
          }}
        >
          {notice}
        </p>
      )}

      {/* 지금 할 일 안내 + 요약 */}
      <section style={{ ...panelStyle, backgroundColor: "#f8fafc" }}>
        <p style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a", lineHeight: 1.6 }}>
          {!isPending
            ? "마감된 명세서입니다. 고칠 것이 있으면 위의 '다시 열기'를 누르세요."
            : lines.length > 0 && incompleteLines.length === 0
              ? "명세서에 적힌 물건이 모두 도착했습니다. 위의 '마감'을 누르면 끝납니다."
              : `명세서 ${lines.length}줄 중 ${summary.counts.COMPLETE}줄이 도착했습니다. 나머지는 현장에서 박스를 찍으면 자동으로 채워집니다.`}
        </p>

        {isPending && lines.length > 0 && incompleteLines.length === 0 && (
          <div style={{ marginTop: "10px" }}>
            <button type="button" onClick={() => setCloseModalOpen(true)} style={{ ...primaryButton, width: "100%", padding: "14px 16px", fontSize: "16px" }}>
              마감하기
            </button>
            <p style={{ margin: "6px 0 0", fontSize: "12px", color: "#64748b" }}>
              마감하면 이 명세서 확인이 끝났다고 기록되고, 박스를 이어 주거나 풀 수 없게 잠깁니다. 고칠 것이 생기면 "다시 열기"로 되돌릴 수 있습니다.
            </p>
          </div>
        )}

        {isPending && matchableUnlinkedCount > 0 && (
          <p style={{ margin: "6px 0 0", fontSize: "13px", color: "#92400e" }}>
            명세서와 맞아 보이는 박스가 {matchableUnlinkedCount}개 있습니다. 아래에서 확인해 주세요.
          </p>
        )}

        <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#64748b" }}>
          명세서 무게 합계 {summary.labeledTotal.toFixed(1)}kg · 지금까지 잰 무게 {summary.actualTotal.toFixed(1)}kg
        </p>

        {incompleteLines.length > 0 && (
          <button type="button" onClick={copySupplierRequest} style={{ ...secondaryButton, marginTop: "10px" }}>
            안 온 물건 {incompleteLines.length}줄, 공급처에 보낼 문구 복사
          </button>
        )}
      </section>

      {/* 줄 표 */}
      <section style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>명세서에 적힌 물건</div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {lines.map((line) => {
            const badge = STATUS_BADGE[line.status];
            const expanded = expandedLineId === line.id;

            return (
              <div key={line.id} style={{ border: "1px solid #e2e8f0", borderRadius: "8px" }}>
                <button
                  type="button"
                  onClick={() => setExpandedLineId(expanded ? null : line.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: "10px",
                    padding: "10px 12px",
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "13px",
                  }}
                >
                  <span style={{ color: "#94a3b8", fontSize: "11px" }}>{line.lineNo}</span>
                  <span style={{ fontWeight: 700, color: "#0f172a" }}>{lineLabel(line)}</span>
                  {(line.partName || line.grade || line.origin) && (
                    <span style={{ color: "#64748b", fontSize: "12px" }}>
                      {[line.partName, line.grade, line.origin].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  {line.productName && (
                    <span style={{ color: "#1e40af", fontSize: "12px" }}>→ {line.productName}</span>
                  )}
                  <span style={{ fontFamily: "monospace", fontSize: "12px", color: "#475569" }}>
                    {line.traceNo ?? line.lotNo ?? "번호 없음"}
                  </span>
                  <span style={{ fontSize: "12px", color: "#334155" }}>
                    도착 {line.linked} / 예정 {line.expected}
                  </span>
                  {line.labeledWeight !== null && (
                    <span style={{ fontSize: "12px", color: "#64748b" }}>
                      {line.isSplitContinuation ? "첫 줄 합계에 포함" : `명세서 ${line.labeledWeight}kg`}
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: "11px",
                      fontWeight: 700,
                      backgroundColor: badge.bg,
                      color: badge.color,
                      borderRadius: "4px",
                      padding: "3px 8px",
                    }}
                  >
                    {badge.label}
                  </span>
                </button>

                {expanded && (
                  <div style={{ padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: "6px" }}>
                    {line.boxes.length === 0 ? (
                      <p style={{ margin: 0, fontSize: "12px", color: "#94a3b8" }}>아직 도착한 박스가 없습니다.</p>
                    ) : (
                      line.boxes.map((box) => {
                        const scanBadge = SCAN_STATUS_BADGE[box.status];

                        return (
                          <div
                            key={box.scanId}
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "center",
                              gap: "8px",
                              fontSize: "12px",
                              padding: "6px 8px",
                              backgroundColor: "#f8fafc",
                              borderRadius: "6px",
                            }}
                          >
                            <span style={{ fontFamily: "monospace" }}>{box.traceNo}</span>
                            <span>{formatWeight(box.weight)}</span>
                            <span style={{ color: "#94a3b8" }}>
                              {new Date(box.createdAt).toLocaleString("ko-KR", {
                                month: "numeric",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                            {scanBadge && (
                              <span
                                style={{
                                  fontSize: "11px",
                                  fontWeight: 700,
                                  backgroundColor: scanBadge.bg,
                                  color: scanBadge.color,
                                  borderRadius: "4px",
                                  padding: "2px 6px",
                                }}
                              >
                                {scanBadge.label}
                              </span>
                            )}
                            <span style={{ color: "#94a3b8" }}>
                              {box.linkedHow === "AUTO" ? "자동" : "수동"}
                            </span>
                            {isPending && (
                              <button
                                type="button"
                                onClick={() => void handleUnlink(box.scanId)}
                                disabled={busyKey === `unlink-${box.scanId}`}
                                style={{ ...linkButton, marginLeft: "auto" }}
                              >
                                연결 해제
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 명세서와 연결 안 된 박스 — 평소엔 접어 둔다 */}
      <section style={panelStyle}>
        <button
          type="button"
          onClick={() => setShowUnlinked((value) => !value)}
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "10px",
            border: "none",
            background: "none",
            cursor: "pointer",
            padding: 0,
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
            명세서와 연결 안 된 박스 ({unlinkedBoxes.length}개)
          </span>
          <span style={{ fontSize: "12px", color: "#64748b" }}>{showUnlinked ? "접기" : "펼치기"}</span>
        </button>

        {showUnlinked && (
          <>
            <p style={{ margin: "8px 0 10px", fontSize: "12px", color: "#64748b", lineHeight: 1.6 }}>
              현장에서 찍었지만 이 명세서의 어느 물건과도 자동으로 이어지지 않은 박스입니다. 명세서에 있는 물건이면
              해당하는 줄을 눌러 이어 주세요. 명세서에 없는 물건이면 그대로 두셔도 됩니다.
            </p>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" }}>
              <span style={{ fontSize: "12px", color: "#64748b" }}>찍은 날짜 범위</span>
              <input
                type="date"
                value={fromInput}
                onChange={(event) => setFromInput(event.target.value)}
                style={{ ...inputStyle, width: "auto" }}
              />
              <span style={{ fontSize: "12px", color: "#94a3b8" }}>~</span>
              <input
                type="date"
                value={toInput}
                onChange={(event) => setToInput(event.target.value)}
                style={{ ...inputStyle, width: "auto" }}
              />
              <button type="button" onClick={applyRange} style={secondaryButton}>
                다시 찾기
              </button>
            </div>
        {unlinkedBoxes.length === 0 ? (
          <p style={{ margin: 0, fontSize: "13px", color: "#94a3b8" }}>이 기간에 연결 안 된 박스가 없습니다.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {unlinkedBoxes.map((box) => {
              const scanBadge = SCAN_STATUS_BADGE[box.status];
              const numberCandidates = box.candidates.filter((c) => c.basis === "NUMBER");
              const suggested = box.candidates.filter((c) => c.basis !== "NUMBER");

              return (
                <div
                  key={box.scanId}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    padding: "10px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", fontSize: "13px" }}>
                    <span style={{ fontFamily: "monospace" }}>{box.traceNo}</span>
                    <span style={{ fontWeight: 700 }}>{formatWeight(box.weight)}</span>
                    <span style={{ color: "#94a3b8", fontSize: "12px" }}>
                      {new Date(box.createdAt).toLocaleString("ko-KR", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {scanBadge && (
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 700,
                          backgroundColor: scanBadge.bg,
                          color: scanBadge.color,
                          borderRadius: "4px",
                          padding: "2px 6px",
                        }}
                      >
                        {scanBadge.label}
                      </span>
                    )}
                  </div>

                  {(box.status === "PENDING_MAPPING" || box.status === "EXCEPTION") && (
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <span style={{ fontSize: "12px", color: "#64748b" }}>상품 지정</span>
                      <select
                        defaultValue=""
                        onChange={(event) => void handleResolveProduct(box.scanId, event.target.value)}
                        disabled={busyKey === `resolve-${box.scanId}`}
                        style={{ ...inputStyle, width: "auto" }}
                      >
                        <option value="">선택</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {isPending && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {numberCandidates.length > 0 &&
                        numberCandidates.map((candidate) => {
                          const line = lineById.get(candidate.lineId);

                          if (!line) return null;

                          return (
                            <button
                              key={candidate.lineId}
                              type="button"
                              onClick={() => void handleLinkCandidate(box.scanId, candidate.lineId, box)}
                              disabled={busyKey === `link-${box.scanId}-${candidate.lineId}`}
                              style={candidateButton}
                            >
                              {lineLabel(line)}
                            </button>
                          );
                        })}

                      {numberCandidates.length === 0 &&
                        suggested.map((candidate) => {
                          const line = lineById.get(candidate.lineId);

                          if (!line) return null;

                          return (
                            <button
                              key={candidate.lineId}
                              type="button"
                              onClick={() => void handleLinkCandidate(box.scanId, candidate.lineId, box)}
                              disabled={busyKey === `link-${box.scanId}-${candidate.lineId}`}
                              style={{ ...candidateButton, borderStyle: "dashed" }}
                              title={
                                candidate.basis === "SUGGESTED_UNCONFIRMED"
                                  ? "축종은 모르지만 무게가 비슷합니다"
                                  : "축종과 무게가 비슷합니다"
                              }
                            >
                              {lineLabel(line)} (비슷해 보임
                              {candidate.basis === "SUGGESTED_UNCONFIRMED" ? " · 무게만 비슷" : ""})
                            </button>
                          );
                        })}

                      {numberCandidates.length === 0 && suggested.length === 0 && (
                        <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                          맞는 줄이 안 보입니다 — 명세서에 없는 물건일 수 있습니다.
                        </span>
                      )}

                      <select
                        defaultValue=""
                        onChange={(event) => {
                          if (event.target.value) void handleLinkCandidate(box.scanId, event.target.value, box);
                          event.target.value = "";
                        }}
                        style={{ ...inputStyle, width: "auto", marginLeft: "auto" }}
                      >
                        <option value="">직접 줄 고르기</option>
                        {lines.map((line) => (
                          <option key={line.id} value={line.id}>
                            {line.lineNo}. {lineLabel(line)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
          </>
        )}
      </section>

      {closeModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(15, 23, 42, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
            zIndex: 50,
          }}
        >
          <div style={{ backgroundColor: "#fff", borderRadius: "12px", padding: "20px", maxWidth: "420px", width: "100%" }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>명세서 마감</div>

            {incompleteLines.length > 0 ? (
              <>
                <p style={{ fontSize: "13px", color: "#475569", marginBottom: "8px" }}>
                  미입고 {incompleteLines.length}줄이 있습니다. 마감하려면 사유를 적어주세요.
                </p>
                <textarea
                  value={closeNote}
                  onChange={(event) => setCloseNote(event.target.value)}
                  rows={3}
                  placeholder="예: 공급처 결품 통보, 나머지는 다음 입고 예정"
                  style={{ ...inputStyle, width: "100%", resize: "vertical" }}
                />
              </>
            ) : (
              <p style={{ fontSize: "13px", color: "#475569", marginBottom: "8px" }}>
                모든 줄이 완료됐습니다. 마감하시겠습니까?
              </p>
            )}

            <div style={{ display: "flex", gap: "8px", marginTop: "14px", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => {
                  setCloseModalOpen(false);
                  setCloseNote("");
                }}
                disabled={closing}
                style={secondaryButton}
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void handleClose()}
                disabled={closing || (incompleteLines.length > 0 && !closeNote.trim())}
                style={primaryButton}
              >
                {closing ? "마감 중…" : "마감"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  backgroundColor: "#ffffff",
  padding: "14px",
};

const inputStyle: React.CSSProperties = {
  border: "1px solid #cbd5f5",
  borderRadius: "8px",
  padding: "7px 9px",
  fontSize: "13px",
  color: "#0f172a",
  backgroundColor: "#ffffff",
};

const primaryButton: React.CSSProperties = {
  border: "none",
  borderRadius: "8px",
  backgroundColor: "#0f172a",
  color: "#ffffff",
  fontSize: "13px",
  fontWeight: 700,
  padding: "9px 16px",
  cursor: "pointer",
};

const secondaryButton: React.CSSProperties = {
  border: "1px solid #cbd5f5",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
  fontSize: "13px",
  fontWeight: 600,
  padding: "9px 14px",
  cursor: "pointer",
};

const linkButton: React.CSSProperties = {
  border: "none",
  background: "none",
  color: "#1d4ed8",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
};

const candidateButton: React.CSSProperties = {
  border: "1px solid #93c5fd",
  borderRadius: "999px",
  backgroundColor: "#eff6ff",
  color: "#1e40af",
  fontSize: "12px",
  fontWeight: 600,
  padding: "6px 12px",
  cursor: "pointer",
};
