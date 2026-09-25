/**
 * 입고 화면 맨 위 "지금 할 일" 카드의 판단 로직.
 *
 * 화면(서버 컴포넌트)이 이미 읽은 데이터만 받아 다음에 할 일 하나를 고른다 — 고정된 1→2→3 순서가 아니라
 * 현재 상태를 보고 고르므로, 명세서는 사무실이 올리고 스캔은 현장이 하는 식으로 나뉘어도 맞는다.
 * 명세서 없이 스캔만으로 끝나는 길은 그대로 유지한다.
 */

export interface InboundNextStepInput {
  /** 대기(PENDING) 명세서 — 오래된 것부터. completeLines/totalLines는 줄 상태 요약. */
  pendingDocuments: Array<{ id: string; completeLines: number; totalLines: number }>;
  /** 명세서엔 있는데 아직 박스가 안 들어온 줄 수. */
  awaitingLineCount: number;
  /** 이력 확인 필요·상품 확인 필요 상태로 남은 박스 수. */
  needsCheckScanCount: number;
  /** 그 중 가장 최근 박스 — 카드 버튼이 내역 맨 위가 아니라 이 박스로 바로 이동한다. */
  firstNeedsCheckScanId?: string | null;
  /** 취소 처리되지 않은 명세서가 하나라도 있는가. */
  hasAnyDocument: boolean;
  /** 취소되지 않은 스캔이 하나라도 있는가. */
  hasAnyScan: boolean;
}

export type InboundNextStepKey =
  | "scan"
  | "reconcile"
  | "close"
  | "review-scans"
  | "upload"
  | "keep-scanning";

export interface InboundNextStep {
  key: InboundNextStepKey;
  title: string;
  detail: string | null;
  buttonLabel: string;
  /** "#id"는 같은 화면 안 이동, "/"로 시작하면 다른 화면. */
  href: string;
  /** 명세서 없이 바로 스캔하는 길 — 명세서를 올리라고 안내할 때만 함께 보인다. */
  secondary: { label: string; href: string } | null;
}

export const INBOUND_ANCHORS = {
  documents: "#inbound-documents",
  scanForm: "#inbound-scan-form",
  history: "#inbound-history",
} as const;

export function documentReconcileHref(documentId: string): string {
  return `/dashboard/inbound/documents/${documentId}`;
}

export function pickInboundNextStep(input: InboundNextStepInput): InboundNextStep {
  const { pendingDocuments, awaitingLineCount, needsCheckScanCount, firstNeedsCheckScanId, hasAnyDocument, hasAnyScan } =
    input;

  if (pendingDocuments.length > 0) {
    if (awaitingLineCount > 0) {
      return {
        key: "scan",
        title: "박스를 찍어 주세요",
        detail: `아직 안 들어온 품목 ${awaitingLineCount}개`,
        buttonLabel: "스캔 시작",
        href: INBOUND_ANCHORS.scanForm,
        secondary: null,
      };
    }

    const unfinished = pendingDocuments.filter((doc) => doc.completeLines < doc.totalLines);

    if (unfinished.length > 0) {
      const lineCount = unfinished.reduce((sum, doc) => sum + (doc.totalLines - doc.completeLines), 0);

      return {
        key: "reconcile",
        title: "확인이 필요한 줄이 있습니다",
        detail: `명세서와 박스를 맞춰 봐야 하는 줄 ${lineCount}개`,
        buttonLabel: "맞춰 보기",
        href: documentReconcileHref(unfinished[0].id),
        secondary: null,
      };
    }

    return {
      key: "close",
      title: "전부 도착했습니다",
      detail: "마감하면 이 명세서는 끝납니다",
      buttonLabel: "마감하러 가기",
      href: documentReconcileHref(pendingDocuments[0].id),
      secondary: null,
    };
  }

  if (needsCheckScanCount > 0) {
    return {
      key: "review-scans",
      title: "확인이 필요한 박스가 있습니다",
      detail: `박스 ${needsCheckScanCount}개`,
      buttonLabel: "확인하러 가기",
      href: firstNeedsCheckScanId ? `#scan-${firstNeedsCheckScanId}` : INBOUND_ANCHORS.history,
      secondary: null,
    };
  }

  if (!hasAnyDocument && !hasAnyScan) {
    return {
      key: "upload",
      title: "먼저 명세서를 올리세요",
      detail: "공급처 명세서가 있으면 박스를 찍을 때 자동으로 맞춰 줍니다",
      buttonLabel: "명세서 올리기",
      href: INBOUND_ANCHORS.documents,
      secondary: { label: "명세서 없이 바로 스캔", href: INBOUND_ANCHORS.scanForm },
    };
  }

  return {
    key: "keep-scanning",
    title: "지금 처리할 일이 없습니다",
    detail: "새로 들어온 물건이 있으면 바로 스캔하세요",
    buttonLabel: "스캔 시작",
    href: INBOUND_ANCHORS.scanForm,
    secondary: { label: "명세서 올리기", href: INBOUND_ANCHORS.documents },
  };
}
