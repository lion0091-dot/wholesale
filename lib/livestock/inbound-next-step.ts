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
}

export type InboundNextStepKey = "scan" | "reconcile" | "close" | "upload";

export interface InboundNextStep {
  key: InboundNextStepKey;
  title: string;
  detail: string | null;
  buttonLabel: string;
  /** "#id"는 같은 화면 안 이동, "/"로 시작하면 다른 화면. */
  href: string;
  /** 큰 버튼 아래 작은 링크들 — 명세서 없이 바로 스캔하는 길, 확인이 필요한 박스 보기. */
  secondaries: Array<{ label: string; href: string }>;
}

export const INBOUND_ANCHORS = {
  nextStep: "#inbound-next-step",
  documents: "#inbound-documents",
  scanForm: "#inbound-scan-form",
  history: "#inbound-history",
} as const;

/** 카드 버튼이 명세서 올리기 칸으로 이동할 때 접혀 있는 칸을 함께 열도록 알리는 창 이벤트 이름. */
export const OPEN_DOCUMENT_PANEL_EVENT = "inbound:open-document-panel";

export function documentReconcileHref(documentId: string): string {
  return `/dashboard/inbound/documents/${documentId}`;
}

export function pickInboundNextStep(input: InboundNextStepInput): InboundNextStep {
  const { pendingDocuments, awaitingLineCount, needsCheckScanCount, firstNeedsCheckScanId } = input;

  if (pendingDocuments.length > 0) {
    if (awaitingLineCount > 0) {
      return {
        key: "scan",
        title: "박스를 찍어 주세요",
        detail: `아직 안 들어온 품목 ${awaitingLineCount}개`,
        buttonLabel: "스캔 시작",
        href: INBOUND_ANCHORS.scanForm,
        secondaries: [],
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
        secondaries: [],
      };
    }

    return {
      key: "close",
      title: "전부 도착했습니다",
      detail: "마감하면 이 명세서는 끝납니다",
      buttonLabel: "마감하러 가기",
      href: documentReconcileHref(pendingDocuments[0].id),
      secondaries: [],
    };
  }

  // 대기 명세서가 없으면 다음 할 일은 언제나 명세서 올리기다. 남아 있는 확인 필요 박스(상품이 정해지지
  // 않으면 재고에 안 들어간다)는 숨기지 않고 작은 링크로 옆에 둔다.
  const secondaries: Array<{ label: string; href: string }> = [
    { label: "명세서 없이 바로 스캔", href: INBOUND_ANCHORS.scanForm },
  ];

  if (needsCheckScanCount > 0) {
    secondaries.push({
      label: `확인이 필요한 박스 ${needsCheckScanCount}개 보기`,
      href: firstNeedsCheckScanId ? `#scan-${firstNeedsCheckScanId}` : INBOUND_ANCHORS.history,
    });
  }

  return {
    key: "upload",
    title: "먼저 명세서를 올리세요",
    detail: "공급처 명세서가 있으면 박스를 찍을 때 자동으로 맞춰 줍니다",
    buttonLabel: "명세서 올리기",
    href: INBOUND_ANCHORS.documents,
    secondaries,
  };
}
