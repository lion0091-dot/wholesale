"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  closeInboundDocumentAction,
  createPurchaseOrderFromDocumentScanAction,
  getDocumentFileUrlAction,
  linkScanToDocumentLineAction,
  reopenInboundDocumentAction,
  setDocumentLineCountModeAction,
  setDocumentSupplierAction,
  unlinkScanFromDocumentLineAction,
} from "../../document-actions";
import { resolveMappingAction } from "../../actions";
import { rejectionBatchSummary, rejectionSummary, type ScanPurchaseOrder } from "@/lib/livestock/scan-purchase-order";
import { TraceNoFixer } from "../../trace-no-fixer";
import type { ScanProductOption } from "../../inbound-scan-view";
import { InboundTabs } from "../../../section-tabs";
import { LineEditor } from "./line-editor";

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
  /** 상품이 정해졌는가 — "발주서 추가 생성"은 상품이 있어야 가능하다. */
  hasProduct: boolean;
  /** 발주서 줄에 아직 안 붙은 무게(kg). 0이면 이미 발주서에 다 붙어 있어 더 할 게 없다. */
  unassignedWeight: number;
}

export interface SupplierOption {
  id: string;
  name: string;
}

export interface LineEdit {
  id: string;
  editedAt: string;
  editedByName: string;
  reason: string | null;
  changes: Array<{ label: string; from: string; to: string }>;
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
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  /** 이 줄을 고친 기록(최근 것부터). */
  edits: LineEdit[];
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
  /** 이 전표가 어느 거래처인지(발주서 연결용, 143). 옛 전표는 비어 있을 수 있다. */
  supplierId: string | null;
  suppliers: SupplierOption[];
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
  /** 발주서 추가 생성·거래처 설정은 사장님·매니저만. */
  canManage: boolean;
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
  supplierId,
  suppliers,
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
  canManage,
}: DocumentReconciliationViewProps) {
  const router = useRouter();
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [supplierPick, setSupplierPick] = useState(supplierId ?? "");
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

  const runAction = async (key: string, run: () => Promise<{ success: boolean; error?: string; data?: unknown }>) => {
    setBusyKey(key);
    setError(null);

    const result = await run();

    setBusyKey(null);

    if (!result.success) {
      setError(result.error ?? "처리하지 못했습니다.");
      return false;
    }

    // 상품을 정하는 순간 발주서 기준으로 이 박스를 받지 않기로 판정되면 재고에 안 들어간다 — 조용히 넘기지 않는다.
    const po = (result.data as { po?: ScanPurchaseOrder | null } | undefined)?.po;

    if (po?.result === "REJECTED") {
      setError(`이 박스는 받지 않았습니다 — ${rejectionSummary(po)} 재고에는 넣지 않았습니다.`);
      router.refresh();
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

  // 지금 할 일은 한 번에 하나만 — 여러 상황이 동시에 있어도 가장 급한 것 하나만 정확히 짚는다
  // (다 늘어놓으면 뭐부터 해야 할지 헷갈린다). 순서: 이미 온 박스 잇기 → 이력 확인 → 상품 지정 →
  // 초과 확인 → 미착 처리 → 마감.
  // exceptionLinkedCount는 unresolvedLinkedCount(EXCEPTION+PENDING_MAPPING)의 부분집합이라
  // 반드시 먼저 확인해야 한다 — 순서가 바뀌면 이력 못 찾은 박스가 있어도 "상품 미지정"으로만
  // 안내되고 번호부터 확인하라는 더 정확한 안내가 영영 안 뜬다.
  const nextStep = useMemo(() => {
    if (!isPending) return null;

    if (matchableUnlinkedCount > 0) {
      return sureUnlinked.length > 0
        ? {
            kind: "sure-unlinked" as const,
            title: `확실한 박스 ${sureUnlinked.length}개를 이으세요`,
            detail:
              matchableUnlinkedCount > sureUnlinked.length
                ? "나머지는 아래 목록에서 직접 골라 이으세요."
                : "전표와 맞는 박스입니다.",
          }
        : {
            kind: "ambiguous-unlinked" as const,
            title: `비슷해 보이는 박스 ${matchableUnlinkedCount}개가 있습니다`,
            detail: "아래 목록에서 맞는 줄을 직접 골라 이으세요.",
          };
    }

    if (exceptionLinkedCount > 0) {
      return {
        kind: "exception" as const,
        title: `이력 못 찾은 박스 ${exceptionLinkedCount}개`,
        detail: "번호부터 확인하세요. 틀렸으면 박스 옆 번호 바꾸기로 고치세요.",
      };
    }

    if (unresolvedLinkedCount > 0) {
      return resolvableLinked.length > 0
        ? {
            kind: "unresolved-auto" as const,
            title: `상품 미지정 박스 ${unresolvedLinkedCount}개`,
            detail:
              resolvableLinked.length < unresolvedLinkedCount
                ? `${resolvableLinked.length}개는 자동 지정되고, 나머지는 직접 지정하세요.`
                : "전표 줄의 상품으로 바로 지정할 수 있습니다.",
          }
        : { kind: "unresolved-manual" as const, title: `상품 미지정 박스 ${unresolvedLinkedCount}개`, detail: "박스에서 상품을 지정하세요." };
    }

    if (overLines.length > 0) {
      return {
        kind: "over" as const,
        title: `더 많이 온 줄 ${overLines.length}개`,
        detail: "잘못 이었을 수 있습니다. 다른 줄로 옮기거나, 진짜 초과면 사유를 적고 마감하세요.",
      };
    }

    if (shortLines.length > 0) {
      return {
        kind: "short" as const,
        title: `아직 안 온 물건 ${shortLines.length}줄`,
        detail: "오는 중이면 기다리고, 끝내 안 오면 사유를 적고 마감하세요.",
      };
    }

    return { kind: "ready-to-close" as const, title: "모두 도착했습니다", detail: "마감하면 끝입니다." };
  }, [isPending, matchableUnlinkedCount, sureUnlinked.length, unresolvedLinkedCount, resolvableLinked.length, exceptionLinkedCount, overLines.length, shortLines.length]);

  const linkAllSure = async () => {
    setBusyKey("batch-link");
    setError(null);

    const rejectedReasons: Array<ScanPurchaseOrder["reason"]> = [];

    for (const box of sureUnlinked) {
      const lineId = box.candidates[0].lineId;
      const result = await linkScanToDocumentLineAction(box.scanId, lineId);

      // 마지막 박스로 전표가 채워져 저절로 마감되면 남은 박스는 이을 곳이 없다 — 오류가 아니다.
      if (!result.success) {
        if (!result.error?.includes("마감")) setError(result.error ?? "처리하지 못했습니다.");
        setBusyKey(null);
        router.refresh();
        return;
      }

      const line = lineById.get(lineId);

      if (line?.productId && box.productId === null && box.status === "PENDING_MAPPING") {
        const resolveResult = await resolveMappingAction(box.scanId, line.productId, false);

        if (resolveResult.success && resolveResult.data?.po?.result === "REJECTED") {
          rejectedReasons.push(resolveResult.data.po.reason);
        }
      }
    }

    // 한 줄로 짧게 — 몇 건이든 늘어놓지 않는다.
    if (rejectedReasons.length > 0) setError(rejectionBatchSummary(rejectedReasons));

    setBusyKey(null);
    router.refresh();
  };

  const resolveAllFromLines = async () => {
    setBusyKey("batch-resolve");
    setError(null);

    const rejectedReasons: Array<ScanPurchaseOrder["reason"]> = [];

    for (const item of resolvableLinked) {
      const result = await resolveMappingAction(item.scanId, item.productId, false);

      if (!result.success) {
        setError(result.error ?? "처리하지 못했습니다.");
        setBusyKey(null);
        router.refresh();
        return;
      }

      if (result.data?.po?.result === "REJECTED") {
        rejectedReasons.push(result.data.po.reason);
      }
    }

    // 한 줄로 짧게 — 몇 건이든 늘어놓지 않는다.
    if (rejectedReasons.length > 0) setError(rejectionBatchSummary(rejectedReasons));

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

  const handleSaveSupplier = async () => {
    if (!supplierPick) return;
    await runAction("supplier", () => setDocumentSupplierAction(documentId, supplierPick));
  };

  const handleCreatePurchaseOrder = async (scanId: string) => {
    const ok = await runAction(`po-create-${scanId}`, () => createPurchaseOrderFromDocumentScanAction(scanId));

    if (ok) setNotice("발주서를 만들었습니다. 발주 관리에서 확인할 수 있습니다.");
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

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "12px", color: "#64748b" }}>거래처(발주서 연결용)</span>
          {canManage ? (
            <>
              <select
                value={supplierPick}
                onChange={(event) => setSupplierPick(event.target.value)}
                style={{ ...inputStyle, width: "auto", padding: "6px 8px", fontSize: "12px" }}
              >
                <option value="">선택 안 함</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
              {supplierPick && supplierPick !== supplierId && (
                <button type="button" onClick={() => void handleSaveSupplier()} disabled={busyKey === "supplier"} style={secondaryButton}>
                  {busyKey === "supplier" ? "저장 중…" : "저장"}
                </button>
              )}
            </>
          ) : (
            <span style={{ fontSize: "12px", color: "#334155" }}>
              {suppliers.find((supplier) => supplier.id === supplierId)?.name ?? "지정 안 됨"}
            </span>
          )}
        </div>

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

        {isPending && (
          <p style={{ margin: 0, fontSize: "12px", color: "#64748b", lineHeight: 1.6 }}>
            전표에 적힌 수량·무게·번호가 틀렸다면 아래 줄을 펼쳐 <strong>줄 내용 고치기</strong>를 누르세요. 고친 기록이 남고, 번호를 바꾸면 박스가 새 번호로 다시 이어집니다.
            공급처·전표번호 같은 머리글이 틀렸거나 엉뚱한 파일을 올렸다면 <Link href="/dashboard/inbound/statements" style={{ color: "#1d4ed8", fontWeight: 600 }}>전표입력</Link>에서
            이 전표를 &apos;취소 처리&apos;하고 다시 올리세요.
          </p>
        )}

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

      {/* 지금 할 일 — 여러 상황이 겹쳐도 가장 급한 것 하나만 정확히 짚는다 */}
      {nextStep ? (
        <section style={{ ...panelStyle, backgroundColor: "#f8fafc" }}>
          <p style={{ margin: 0, fontSize: "12px", fontWeight: 700, color: "#1d4ed8" }}>지금 할 일</p>
          <p style={{ margin: "4px 0 0", fontSize: "15px", fontWeight: 800, color: "#0f172a" }}>{nextStep.title}</p>
          <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#475569", lineHeight: 1.6 }}>{nextStep.detail}</p>

          <div style={{ marginTop: "10px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {nextStep.kind === "sure-unlinked" && (
              <button type="button" onClick={() => void linkAllSure()} disabled={busyKey === "batch-link"} style={primaryButton}>
                {busyKey === "batch-link" ? "잇는 중…" : `확실한 ${sureUnlinked.length}개 한꺼번에 잇기`}
              </button>
            )}

            {nextStep.kind === "ambiguous-unlinked" && (
              <button
                type="button"
                onClick={() => {
                  setShowUnlinked(true);
                  window.setTimeout(() => document.getElementById("unlinked-boxes")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
                }}
                style={primaryButton}
              >
                박스 목록 보기
              </button>
            )}

            {nextStep.kind === "unresolved-auto" && (
              <>
                <button type="button" onClick={() => void resolveAllFromLines()} disabled={busyKey === "batch-resolve"} style={primaryButton}>
                  {busyKey === "batch-resolve" ? "지정 중…" : `${resolvableLinked.length}개 한꺼번에 지정`}
                </button>
                {firstUnresolved && resolvableLinked.length < unresolvedLinkedCount && (
                  <button type="button" onClick={() => jumpTo(firstUnresolved.lineId, `box-${firstUnresolved.scanId}`)} style={secondaryButton}>
                    나머지 직접 지정하기
                  </button>
                )}
              </>
            )}

            {nextStep.kind === "unresolved-manual" && firstUnresolved && (
              <button type="button" onClick={() => jumpTo(firstUnresolved.lineId, `box-${firstUnresolved.scanId}`)} style={primaryButton}>
                상품 지정하러 가기
              </button>
            )}

            {nextStep.kind === "exception" && firstException && (
              <Link href={`/dashboard/inbound#scan-${firstException.scanId}`} style={{ ...primaryButton, textDecoration: "none", display: "inline-block" }}>
                스캔 화면에서 확인하기
              </Link>
            )}

            {nextStep.kind === "over" && overLines[0] && (
              <button type="button" onClick={() => jumpTo(overLines[0].id, `line-${overLines[0].id}`)} style={primaryButton}>
                그 줄 열기
              </button>
            )}

            {nextStep.kind === "short" && (
              <>
                <button type="button" onClick={() => setCloseModalOpen(true)} style={primaryButton}>
                  안 온 채로 마감하기
                </button>
                <button type="button" onClick={copySupplierRequest} style={secondaryButton}>
                  공급처에 보낼 문구 복사
                </button>
              </>
            )}

            {nextStep.kind === "ready-to-close" && (
              <button type="button" onClick={() => setCloseModalOpen(true)} style={primaryButton}>
                마감하기
              </button>
            )}
          </div>

          <p style={{ margin: "10px 0 0", fontSize: "11px", color: "#94a3b8" }}>
            전표 {summary.labeledTotal.toFixed(1)}kg · 실측 {summary.actualTotal.toFixed(1)}kg
          </p>
        </section>
      ) : (
        <p style={{ margin: 0, fontSize: "13px", color: "#64748b" }}>마감된 전표입니다. 고칠 게 있으면 위 &quot;다시 열기&quot;를 누르세요.</p>
      )}

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
                    {isPending || line.edits.length > 0 ? <LineEditor line={line} products={products} canEdit={isPending} /> : null}
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
                            {canManage && supplierId && box.hasProduct && box.unassignedWeight > 0 && (
                              <button
                                type="button"
                                onClick={() => void handleCreatePurchaseOrder(box.scanId)}
                                disabled={busyKey === `po-create-${box.scanId}`}
                                style={secondaryButton}
                                title={`발주서에 안 붙은 ${formatWeight(box.unassignedWeight)}만큼 발주서를 사후에 만듭니다`}
                              >
                                {busyKey === `po-create-${box.scanId}` ? "만드는 중…" : "발주서 추가 생성"}
                              </button>
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
      <section id="unlinked-boxes" style={panelStyle}>
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
                  placeholder={
                    overLines.length > 0 && shortLines.length === 0
                      ? "예: 한 마리가 여러 박스로 옴, 공급처가 수량을 잘못 적음"
                      : "예: 공급처 결품 통보, 나머지는 다음 입고 예정"
                  }
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
