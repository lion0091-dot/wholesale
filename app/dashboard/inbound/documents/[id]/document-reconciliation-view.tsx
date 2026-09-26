"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  closeInboundDocumentAction,
  getDocumentFileUrlAction,
  linkScanToDocumentLineAction,
  reopenInboundDocumentAction,
  setDocumentLineCountModeAction,
  unlinkScanFromDocumentLineAction,
} from "../../document-actions";
import { resolveMappingAction } from "../../actions";
import { TraceNoFixer } from "../../trace-no-fixer";
import type { ScanProductOption } from "../../inbound-scan-view";
import { InboundTabs } from "../../../section-tabs";

/**
 * 29단계 B — 전표 ↔ 실물 박스 사무실 대조 화면.
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
  /** 박스 기준이면 예정 박스 수, 무게 기준이면 1(환산값 — 화면은 무게로 말한다). */
  expected: number;
  /** 이어진(취소 제외) 실제 박스 수. */
  linked: number;
  status: LineMatchStatus;
  /** 지금 이 줄이 무엇으로 세는지(자동 규칙 또는 사무실이 고정한 값의 결과). */
  mode: "BOXES" | "WEIGHT";
  /** 사무실이 고정한 기준. null이면 자동. */
  countMode: "BOXES" | "WEIGHT" | null;
  /** 이어진 박스 무게 합계(kg). */
  linkedWeight: number;
  labeledWeight: number | null;
  /** raw_text의 "(이력번호 k/N)"에서 k>1 — 표기중량은 첫 줄 합계에 포함된 것. */
  isSplitContinuation: boolean;
  boxes: ReconciliationLineBox[];
}

export interface UnlinkedBoxCandidate {
  lineId: string;
  /** NUMBER: 번호로 확정된 후보. SUGGESTED: 축종+중량 제안. SUGGESTED_UNCONFIRMED: 중량만(축종 모름). */
  basis: "NUMBER" | "SUGGESTED" | "SUGGESTED_UNCONFIRMED";
  /** 박스 부위가 이 줄의 품목명·부위에 적혀 있다. */
  partConfirmed?: boolean;
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

/** 줄의 도착 현황 문구 — 박스 기준은 "도착 2 / 예정 3", 무게 기준은 "도착 8.2kg / 표기 10kg". */
function arrivalText(line: ReconciliationLine): string {
  if (line.mode === "WEIGHT") {
    return `도착 ${line.linkedWeight}kg / 표기 ${line.labeledWeight}kg (박스 ${line.linked}개)`;
  }

  return `도착 ${line.linked} / 예정 ${line.expected}`;
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
  // 평소엔 볼 일이 없다 — 전표와 맞아 보이는 박스가 있을 때만 처음부터 펼친다.
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
  // "안 온 줄"과 "더 많이 온 줄"은 할 일이 다르다 — 섞어서 안내하면 더 온 줄에 "기다리세요"가 나온다.
  const shortLines = lines.filter((line) => line.status === "AWAITING" || line.status === "PARTIAL");
  const overLines = lines.filter((line) => line.status === "OVER");
  // 전표에는 이어졌지만 상품이 안 정해져 재고에 아직 안 들어간 박스.
  const unresolvedLinkedCount = lines.reduce(
    (sum, line) => sum + line.boxes.filter((box) => box.status === "EXCEPTION" || box.status === "PENDING_MAPPING").length,
    0
  );

  // 안내문이 가리키는 자리(줄·박스)를 펼치고 화면 가운데로 데려간다.
  const jumpTo = (lineId: string, targetId: string) => {
    setExpandedLineId(lineId);
    window.setTimeout(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  };

  const firstException = lines
    .flatMap((line) => line.boxes.filter((box) => box.status === "EXCEPTION"))[0];
  const exceptionLinkedCount = lines.reduce(
    (sum, line) => sum + line.boxes.filter((box) => box.status === "EXCEPTION").length,
    0
  );

  const firstUnresolved = lines
    .flatMap((line) =>
      line.boxes
        .filter((box) => box.status === "EXCEPTION" || box.status === "PENDING_MAPPING")
        .map((box) => ({ lineId: line.id, scanId: box.scanId }))
    )[0];

  // 다른 화면의 안내 버튼이 "#box-<박스>"(그 박스로 가기)나 "#close"(마감 창 열기)를 달고 넘어온다.
  useEffect(() => {
    const hash = window.location.hash;

    // 새로고침할 때 마감 창이 또 뜨지 않게 주소의 해시는 한 번 쓰고 지운다.
    if (hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);

    if (hash === "#close") {
      if (isPending) setCloseModalOpen(true);
      return;
    }

    if (hash.startsWith("#box-")) {
      const scanId = hash.slice("#box-".length);
      const owner = lines.find((line) => line.boxes.some((box) => box.scanId === scanId));

      if (owner) jumpTo(owner.id, `box-${scanId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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

    // 박스는 상품 미확정인데 그 줄엔 상품이 지정돼 있으면 그 줄 상품으로 바로 확정한다(고를 것이 없다).
    // 이력을 못 찾은 박스(EXCEPTION)는 번호부터 봐야 하므로 자동 지정하지 않고, 지정해도 바코드 상품으로 학습하지 않는다
    // (전표 줄의 상품이 틀렸을 때 잘못된 기억이 남지 않게).
    if (line?.productId && box.productId === null && box.status === "PENDING_MAPPING") {
      await runAction(`resolve-${scanId}`, async () => resolveMappingAction(scanId, line.productId!, false));
    }
  };

  // 후보가 하나뿐이고 축종까지 맞는 박스는 고를 것이 없다 — 한 번에 이어 준다.
  const sureUnlinked = unlinkedBoxes.filter(
    (box) => box.candidates.length === 1 && box.candidates[0].basis !== "SUGGESTED_UNCONFIRMED"
  );
  // 이미 이어졌고 줄에 상품이 지정돼 있는데 박스 상품만 비어 있는 것 — 줄 상품으로 정하면 된다.
  const resolvableLinked = lines.flatMap((line) =>
    line.productId
      ? line.boxes
          .filter((box) => box.status === "PENDING_MAPPING")
          .map((box) => ({ scanId: box.scanId, productId: line.productId! }))
      : []
  );

  const linkAllSure = async () => {
    setBusyKey("batch-link");
    setError(null);

    for (const box of sureUnlinked) {
      const lineId = box.candidates[0].lineId;
      const result = await linkScanToDocumentLineAction(box.scanId, lineId);

      // 마지막 박스로 전표가 채워져 저절로 마감되면 남은 박스는 이을 곳이 없다 — 오류가 아니다.
      if (!result.success) {
        if (!result.error?.includes("마감")) setError(result.error ?? "처리하지 못했습니다.");
        break;
      }

      const line = lineById.get(lineId);

      if (line?.productId && box.productId === null && box.status === "PENDING_MAPPING") {
        await resolveMappingAction(box.scanId, line.productId, false);
      }
    }

    setBusyKey(null);
    router.refresh();
  };

  const resolveAllFromLines = async () => {
    setBusyKey("batch-resolve");
    setError(null);

    for (const item of resolvableLinked) {
      const result = await resolveMappingAction(item.scanId, item.productId, false);

      if (!result.success) {
        setError(result.error ?? "처리하지 못했습니다.");
        break;
      }
    }

    setBusyKey(null);
    router.refresh();
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
      `[${supplierName ?? "공급처"}] 전표 대조 — 미입고 확인 요청\n` +
      shortLines
        .map((line) =>
          line.mode === "WEIGHT"
            ? `- ${lineLabel(line)} (표기 ${line.labeledWeight}kg / 입고 ${line.linkedWeight}kg)`
            : `- ${lineLabel(line)} (예정 ${line.expected} / 입고 ${line.linked})`
        )
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
            ? "마감된 전표입니다. 고칠 것이 있으면 위의 '다시 열기'를 누르세요."
            : incompleteLines.length === 0
              ? unresolvedLinkedCount === 0
                ? "물건이 모두 도착했습니다. 위의 '마감'을 누르면 끝납니다."
                : "물건은 모두 도착했습니다. 아래 안내대로 상품 정하기를 먼저 하세요."
              : `${lines.length}줄 중 ${summary.counts.COMPLETE}줄 도착.` +
                (shortLines.length > 0 ? ` 안 온 물건 ${shortLines.length}줄` : "") +
                (overLines.length > 0 ? ` · 더 온 줄 ${overLines.length}줄` : "")}
        </p>

        {isPending && lines.length > 0 && incompleteLines.length === 0 && (
          <div style={{ marginTop: "10px" }}>
            <button type="button" onClick={() => setCloseModalOpen(true)} style={{ ...primaryButton, width: "100%", padding: "14px 16px", fontSize: "16px" }}>
              마감하기
            </button>
            <p style={{ margin: "6px 0 0", fontSize: "12px", color: "#64748b" }}>
              마감하면 박스 연결이 잠깁니다. 고칠 게 생기면 "다시 열기"를 누르세요.
            </p>
          </div>
        )}

        {isPending && matchableUnlinkedCount > 0 && (
          <p style={{ margin: "6px 0 0", fontSize: "13px", color: "#92400e" }}>
            전표와 맞아 보이는 박스가 {matchableUnlinkedCount}개 있습니다.
            {sureUnlinked.length > 0 && (
              <button
                type="button"
                onClick={() => void linkAllSure()}
                disabled={busyKey === "batch-link"}
                style={{ ...primaryButton, marginLeft: "8px" }}
              >
                {busyKey === "batch-link" ? "잇는 중…" : `확실한 ${sureUnlinked.length}개 한꺼번에 이어 주기`}
              </button>
            )}
            {matchableUnlinkedCount > sureUnlinked.length && " 나머지는 아래에서 골라 주세요."}
          </p>
        )}

        <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#64748b" }}>
          전표 무게 합계 {summary.labeledTotal.toFixed(1)}kg · 지금까지 잰 무게 {summary.actualTotal.toFixed(1)}kg
        </p>

        {isPending && unresolvedLinkedCount > 0 && (
          <p style={{ margin: "8px 0 0", fontSize: "13px", color: "#92400e", lineHeight: 1.7 }}>
            <strong>상품이 안 정해진 박스 {unresolvedLinkedCount}개</strong>는 재고에 아직 안 들어갔습니다.
            {resolvableLinked.length > 0
              ? `${resolvableLinked.length}개는 전표 줄의 상품으로 바로 지정할 수 있습니다.`
              : "버튼을 누르면 그 박스로 이동합니다."}
            {resolvableLinked.length > 0 && (
              <button
                type="button"
                onClick={() => void resolveAllFromLines()}
                disabled={busyKey === "batch-resolve"}
                style={{ ...primaryButton, marginLeft: "8px" }}
              >
                {busyKey === "batch-resolve" ? "지정 중…" : `${resolvableLinked.length}개 한꺼번에 지정`}
              </button>
            )}
            {firstUnresolved && resolvableLinked.length < unresolvedLinkedCount && (
              <button
                type="button"
                onClick={() => jumpTo(firstUnresolved.lineId, `box-${firstUnresolved.scanId}`)}
                style={{ ...secondaryButton, marginLeft: "8px" }}
              >
                상품 지정하러 가기
              </button>
            )}
          </p>
        )}

        {isPending && exceptionLinkedCount > 0 && firstException && (
          <p style={{ margin: "8px 0 0", fontSize: "13px", color: "#991b1b", lineHeight: 1.7 }}>
            <strong>이력을 못 찾은 박스 {exceptionLinkedCount}개</strong> — 번호부터 확인하세요. 번호가 틀렸으면 박스 옆 <strong>번호 바꾸기</strong>로
            바로잡으세요(무게·위치는 그대로 옮겨지고 저절로 확인됩니다). 번호가 맞으면 시스템이 자동으로 다시 조회하니 기다리거나, 박스 옆에서 상품을 지정하세요.
            <Link
              href={`/dashboard/inbound#scan-${firstException.scanId}`}
              style={{ ...secondaryButton, marginLeft: "8px", textDecoration: "none", display: "inline-block" }}
            >
              스캔 화면에서 확인하기
            </Link>
          </p>
        )}

        {isPending && overLines.length > 0 && (
          <p style={{ margin: "8px 0 0", fontSize: "13px", color: "#991b1b", lineHeight: 1.7 }}>
            <strong>"더 많이 옴" 줄</strong>은 다른 줄의 박스를 잘못 이은 걸 수 있습니다. 박스 옆 <strong>다른 줄로 옮기기</strong>로
            바로잡으세요. 진짜 더 온 거면 사유를 적고 마감하세요.
            {overLines[0] && (
              <button
                type="button"
                onClick={() => jumpTo(overLines[0].id, `line-${overLines[0].id}`)}
                style={{ ...secondaryButton, marginLeft: "8px" }}
              >
                그 줄 열기
              </button>
            )}
          </p>
        )}

        {isPending && shortLines.length > 0 && (
          <ol style={{ margin: "8px 0 0", paddingLeft: "20px", fontSize: "13px", color: "#334155", lineHeight: 1.7 }}>
            <li>
              <strong>오는 중이면</strong> — 기다리세요. 박스를 찍으면 저절로 채워집니다.
            </li>
            <li>
              <strong>끝내 안 오면</strong> — 사유(예: 결품)를 적고 마감하세요.{" "}
              <button type="button" onClick={() => setCloseModalOpen(true)} style={secondaryButton}>
                안 온 채로 마감하기
              </button>
            </li>
          </ol>
        )}

        {shortLines.length > 0 && (
          <button type="button" onClick={copySupplierRequest} style={{ ...secondaryButton, marginTop: "10px" }}>
            안 온 물건 {shortLines.length}줄, 공급처에 보낼 문구 복사
          </button>
        )}
      </section>

      {/* 줄 표 */}
      <section style={panelStyle}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a", marginBottom: "10px" }}>전표에 적힌 물건</div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {lines.map((line) => {
            const badge = STATUS_BADGE[line.status];
            const expanded = expandedLineId === line.id;

            return (
              <div key={line.id} id={`line-${line.id}`} style={{ border: "1px solid #e2e8f0", borderRadius: "8px" }}>
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
                    {arrivalText(line)}
                  </span>
                  {line.labeledWeight !== null && (
                    <span style={{ fontSize: "12px", color: "#64748b" }}>
                      {line.isSplitContinuation ? "첫 줄 합계에 포함" : `전표 ${line.labeledWeight}kg`}
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
                    {isPending && line.labeledWeight !== null && !line.isSplitContinuation && (
                      <label style={{ fontSize: "12px", color: "#475569", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                        다 왔는지 세는 기준
                        <select
                          value={line.countMode ?? "AUTO"}
                          disabled={busyKey === `mode-${line.id}`}
                          onChange={(event) =>
                            void runAction(`mode-${line.id}`, () =>
                              setDocumentLineCountModeAction(line.id, event.target.value as "AUTO" | "BOXES" | "WEIGHT")
                            )
                          }
                          style={{ ...inputStyle, width: "auto", padding: "4px 6px", fontSize: "12px" }}
                        >
                          <option value="AUTO">자동 (지금은 {line.mode === "WEIGHT" ? "무게" : "박스 수"})</option>
                          <option value="BOXES">박스 수</option>
                          <option value="WEIGHT">무게</option>
                        </select>
                        <span style={{ color: "#94a3b8" }}>
                          {line.mode === "WEIGHT"
                            ? "몇 박스로 나뉘어 와도 무게가 표기와 ±2% 안이면 다 온 것으로 봅니다."
                            : "박스 수가 예정과 같으면 다 온 것으로 봅니다."}
                        </span>
                      </label>
                    )}
                    {line.boxes.length === 0 ? (
                      <p style={{ margin: 0, fontSize: "12px", color: "#94a3b8" }}>아직 도착한 박스가 없습니다.</p>
                    ) : (
                      line.boxes.map((box) => {
                        const scanBadge = SCAN_STATUS_BADGE[box.status];

                        return (
                          <div
                            key={box.scanId}
                            id={`box-${box.scanId}`}
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
                            {isPending && box.status === "EXCEPTION" && (
                              <TraceNoFixer scanId={box.scanId} traceNo={box.traceNo} compact />
                            )}
                            {isPending && (box.status === "PENDING_MAPPING" || box.status === "EXCEPTION") && (
                              <select
                                defaultValue=""
                                onChange={(event) => void handleResolveProduct(box.scanId, event.target.value)}
                                disabled={busyKey === `resolve-${box.scanId}`}
                                aria-label="상품 지정"
                                style={{ ...inputStyle, width: "auto", padding: "4px 6px", fontSize: "12px" }}
                              >
                                <option value="">상품 지정</option>
                                {products.map((product) => (
                                  <option key={product.id} value={product.id}>
                                    {product.name}
                                  </option>
                                ))}
                              </select>
                            )}
                            {isPending && lines.length > 1 && (
                              <select
                                defaultValue=""
                                aria-label="다른 줄로 옮기기"
                                disabled={busyKey === `move-${box.scanId}`}
                                onChange={(event) => {
                                  const targetLineId = event.target.value;

                                  event.target.value = "";
                                  if (targetLineId) {
                                    void runAction(`move-${box.scanId}`, () =>
                                      linkScanToDocumentLineAction(box.scanId, targetLineId)
                                    );
                                  }
                                }}
                                style={{ ...inputStyle, width: "auto", padding: "4px 6px", fontSize: "12px" }}
                              >
                                <option value="">다른 줄로 옮기기</option>
                                {lines
                                  .filter((other) => other.id !== line.id)
                                  .map((other) => (
                                    <option key={other.id} value={other.id}>
                                      {other.lineNo}. {lineLabel(other)}
                                    </option>
                                  ))}
                              </select>
                            )}
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

      {/* 전표와 연결 안 된 박스 — 평소엔 접어 둔다 */}
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
            전표와 연결 안 된 박스 ({unlinkedBoxes.length}개)
          </span>
          <span style={{ fontSize: "12px", color: "#64748b" }}>{showUnlinked ? "접기" : "펼치기"}</span>
        </button>

        {showUnlinked && (
          <>
            <p style={{ margin: "8px 0 10px", fontSize: "12px", color: "#64748b", lineHeight: 1.6 }}>
              현장에서 찍었지만 이 전표의 어느 물건과도 자동으로 이어지지 않은 박스입니다. 전표에 있는 물건이면
              해당하는 줄을 눌러 이어 주세요. 전표에 없는 물건이면 그대로 두셔도 됩니다.
            </p>
            {!isPending && (
              <p style={{ margin: "0 0 10px", fontSize: "12px", color: "#92400e" }}>
                마감 상태에서는 이을 수 없습니다.{" "}
                <button type="button" onClick={handleReopen} disabled={busyKey === "reopen"} style={secondaryButton}>
                  다시 열기
                </button>
              </p>
            )}
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
                                  : candidate.partConfirmed
                                    ? "축종·부위·무게가 비슷합니다"
                                    : "축종과 무게가 비슷합니다"
                              }
                            >
                              {lineLabel(line)} (비슷해 보임
                              {candidate.basis === "SUGGESTED_UNCONFIRMED" ? " · 무게만 비슷" : ""}
                              {candidate.partConfirmed ? " · 부위 같음" : ""})
                            </button>
                          );
                        })}

                      {numberCandidates.length === 0 && suggested.length === 0 && (
                        <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                          맞는 줄이 안 보입니다 — 전표에 없는 물건일 수 있습니다.
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
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>전표 마감</div>

            {incompleteLines.length > 0 ? (
              <>
                <p style={{ fontSize: "13px", color: "#475569", marginBottom: "8px" }}>
                  {[
                    shortLines.length > 0 ? `안 온 물건 ${shortLines.length}줄` : null,
                    overLines.length > 0 ? `더 많이 온 줄 ${overLines.length}줄` : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  이 있습니다. 마감하려면 사유를 적어주세요.
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
                {unresolvedLinkedCount > 0 &&
                  ` (상품 미지정 박스 ${unresolvedLinkedCount}개는 재고에 아직 안 들어갑니다.)`}
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
