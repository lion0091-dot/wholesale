/**
 * 입고 화면 맨 위 "지금 할 일" 카드의 판단 로직.
 *
 * 화면(서버 컴포넌트)이 이미 읽은 데이터만 받아 다음에 할 일 하나를 고른다 — 고정된 1→2→3 순서가 아니라
 * 현재 상태를 보고 고르므로, 명세서는 사무실이 올리고 스캔은 현장이 하는 식으로 나뉘어도 맞는다.
 * 명세서 없이 스캔만으로 끝나는 길은 그대로 유지한다.
 */

export interface InboundNextStepInput {
  /** 대기(PENDING) 명세서 — 오래된 것부터. completeLines/totalLines는 줄 상태 요약. */
  pendingDocuments: Array<{
    id: string;
    /** 현장이 스캔 종료를 표시했는가. */
    scanFinished?: boolean;
    completeLines: number;
    totalLines: number;
    /** 명세서에 이어졌지만 상품이 안 정해져(이력 확인 필요 등) 재고에 아직 안 들어간 박스 수. */
    unresolvedBoxes?: number;
    /** 그 중 첫 박스 — 카드 버튼이 이 박스로 바로 이동한다. */
    firstUnresolvedScanId?: string | null;
  }>;
  /**
   * 명세서 기준으로 아직 안 들어온 박스 수 — 박스가 하나도 안 온 줄은 예정 수량만큼, 일부만 온 줄은
   * 모자란 만큼 센다(수량 2인 줄에 1박스만 왔으면 1개가 남는다).
   */
  remainingBoxCount: number;
  /** 이력 확인 필요·상품 확인 필요 상태로 남은 박스 수. */
  needsCheckScanCount: number;
  /** 그 중 가장 최근 박스 — 카드 버튼이 내역 맨 위가 아니라 이 박스로 바로 이동한다. */
  firstNeedsCheckScanId?: string | null;
}

export type InboundNextStepKey =
  | "scan"
  | "scan-finished"
  | "reconcile"
  | "close"
  | "upload"
  | "field-scan"
  | "field-done"
  | "field-start";

export interface InboundNextStep {
  key: InboundNextStepKey;
  /** 이 단계를 하는 사람 — 명세서는 사무실, 박스 스캔은 현장. */
  who: "사무실" | "현장";
  title: string;
  detail: string | null;
  buttonLabel: string;
  /** true면 누를 수 없는 대기 표시 — 사무실이 현장 스캔을 기다리는 단계. */
  buttonDisabled?: boolean;
  /** 있으면 큰 버튼이 이동이 아니라 이 명세서를 바로 마감한다(모든 줄이 맞고 재고도 다 반영된 경우). */
  closeDocumentId?: string;
  /** "#id"는 같은 화면 안 이동, "/"로 시작하면 다른 화면(입고 스캔 ↔ 전표입력). */
  href: string;
  /** 이 단계를 하지 않는 쪽에게 "지금은 기다리면 된다"고 알리는 안내. */
  waitNote: { who: "사무실" | "현장"; text: string } | null;
  /** 큰 버튼 아래 작은 링크들 — 명세서 없이 바로 스캔하는 길, 확인이 필요한 박스 보기. */
  secondaries: Array<{ label: string; href: string }>;
}

export const INBOUND_ANCHORS = {
  nextStep: "#inbound-next-step",
  documents: "#inbound-documents",
  scanForm: "#inbound-scan-form",
  history: "#inbound-history",
} as const;

/** 입고는 두 화면이다 — 현장이 쓰는 입고 스캔, 사무실이 쓰는 전표입력(명세서 올리기·대조·마감). */
export const INBOUND_SCAN_PATH = "/dashboard/inbound";
export const INBOUND_STATEMENTS_PATH = "/dashboard/inbound/statements";

/** 전표입력 화면에서 입고 스캔 화면의 칸으로 가는 링크(다른 화면이라 경로를 붙인다). */
const SCAN_FORM_LINK = `${INBOUND_SCAN_PATH}${INBOUND_ANCHORS.scanForm}`;
const SCAN_HISTORY_LINK = `${INBOUND_SCAN_PATH}${INBOUND_ANCHORS.history}`;
const scanBoxLink = (scanId: string) => `${INBOUND_SCAN_PATH}#scan-${scanId}`;

/** 카드 버튼이 명세서 올리기 칸으로 이동할 때 접혀 있는 칸을 함께 열도록 알리는 창 이벤트 이름. */
export const OPEN_DOCUMENT_PANEL_EVENT = "inbound:open-document-panel";

export function documentReconcileHref(documentId: string): string {
  return `/dashboard/inbound/documents/${documentId}`;
}

/** 대조가 필요한 명세서로 안내한다 — 줄이 다 맞은 명세서가 아니라 안 온 박스가 남은 쪽이어야 사무실이 바로 처리한다. */
function pickAttentionDocument(docs: InboundNextStepInput["pendingDocuments"]) {
  return docs.find((doc) => doc.completeLines < doc.totalLines) ?? docs[0];
}

export function pickInboundNextStep(input: InboundNextStepInput): InboundNextStep {
  const { pendingDocuments, remainingBoxCount, needsCheckScanCount, firstNeedsCheckScanId } = input;

  if (pendingDocuments.length > 0) {
    if (remainingBoxCount > 0 && pendingDocuments.every((doc) => doc.scanFinished)) {
      // 박스가 끝내 다 안 왔다고 현장이 알렸다 — 안 온 물건을 사유와 함께 남기고 마감하는 단계다.
      return {
        key: "scan-finished",
        who: "사무실",
        title: "현장 스캔이 종료됐습니다",
        detail: `안 온 박스 ${remainingBoxCount}개가 남았습니다. 안 온 물건과 사유를 확인하고 마감하세요.`,
        waitNote: { who: "현장", text: "스캔 종료를 알렸습니다. 사무실이 확인하는 중입니다. 박스가 더 오면 스캔 화면에서 '스캔 다시 시작'을 누르세요." },
        buttonLabel: "확인·마감하기",
        href: documentReconcileHref(pickAttentionDocument(pendingDocuments).id),
        secondaries: [{ label: "현장: 스캔 화면으로 이동", href: SCAN_FORM_LINK }],
      };
    }

    if (remainingBoxCount > 0) {
      return {
        key: "scan",
        who: "사무실",
        title: "현장에서 스캔 중입니다",
        detail: `아직 안 들어온 박스 ${remainingBoxCount}개. 종료까지 기다려 주세요. 스캔이 끝나면 이 버튼이 "마감하기"로 바뀝니다.`,
        waitNote: null,
        buttonLabel: "스캔 중 대기",
        buttonDisabled: true,
        href: SCAN_FORM_LINK,
        secondaries: [
          { label: "현장: 스캔 화면으로 이동", href: SCAN_FORM_LINK },
          // 공급처가 물건을 덜 보냈으면 박스는 끝내 다 안 온다 — 이때는 안 온 물건을 사유와 함께 남기고 마감한다.
          { label: "박스가 다 안 왔어도 확인·마감하기 (사무실)", href: documentReconcileHref(pickAttentionDocument(pendingDocuments).id) },
        ],
      };
    }

    const unfinished = pendingDocuments.filter((doc) => doc.completeLines < doc.totalLines);

    if (unfinished.length > 0) {
      const lineCount = unfinished.reduce((sum, doc) => sum + (doc.totalLines - doc.completeLines), 0);

      return {
        key: "reconcile",
        who: "사무실",
        title: "확인이 필요한 줄이 있습니다",
        detail: `명세서와 박스를 맞춰 봐야 하는 줄 ${lineCount}개`,
        waitNote: { who: "현장", text: "스캔은 끝났습니다. 사무실이 명세서와 맞춰 보는 중입니다." },
        buttonLabel: "맞춰 보기",
        href: documentReconcileHref(unfinished[0].id),
        secondaries: [],
      };
    }

    const unresolved = pendingDocuments.reduce((sum, doc) => sum + (doc.unresolvedBoxes ?? 0), 0);
    const firstUnresolvedScanId = pendingDocuments.find((doc) => doc.firstUnresolvedScanId)?.firstUnresolvedScanId;

    if (unresolved > 0) {
      return {
        key: "close",
        who: "사무실",
        title: "전부 도착했습니다",
        detail: `다만 상품 확인이 필요한 박스 ${unresolved}개는 재고에 아직 안 들어갔습니다. 그 박스의 상품을 지정하면 이 카드가 "마감하기"로 바뀝니다.`,
        waitNote: null,
        buttonLabel: "상품 지정하러 가기",
        href: firstUnresolvedScanId ? scanBoxLink(firstUnresolvedScanId) : SCAN_HISTORY_LINK,
        secondaries: [
          {
            label: "그래도 마감하러 가기",
            href: documentReconcileHref((pendingDocuments.find((doc) => (doc.unresolvedBoxes ?? 0) > 0) ?? pendingDocuments[0]).id),
          },
        ],
      };
    }

    return {
      key: "close",
      who: "사무실",
      title: "전부 입고 완료되었습니다",
      detail: "재고에 모두 반영됐습니다. 마감하면 명세서 확인까지 끝납니다.",
      waitNote: { who: "현장", text: "스캔은 끝났습니다. 사무실이 마감하면 이 명세서는 끝납니다." },
      buttonLabel: "마감하기",
      closeDocumentId: pendingDocuments[0].id,
      href: documentReconcileHref(pendingDocuments[0].id),
      secondaries: [],
    };
  }

  // 대기 명세서가 없으면 다음 할 일은 언제나 명세서 올리기다. 남아 있는 확인 필요 박스(상품이 정해지지
  // 않으면 재고에 안 들어간다)는 숨기지 않고 작은 링크로 옆에 둔다.
  const secondaries: Array<{ label: string; href: string }> = [
    { label: "명세서 없이 바로 스캔", href: SCAN_FORM_LINK },
  ];

  if (needsCheckScanCount > 0) {
    secondaries.push({
      label: `확인이 필요한 박스 ${needsCheckScanCount}개 보기`,
      href: firstNeedsCheckScanId ? scanBoxLink(firstNeedsCheckScanId) : SCAN_HISTORY_LINK,
    });
  }

  return {
    key: "upload",
    who: "사무실",
    title: "먼저 명세서를 올리세요",
    detail: "공급처 명세서가 있으면 박스를 찍을 때 자동으로 맞춰 줍니다",
    buttonLabel: "명세서 올리기",
    href: INBOUND_ANCHORS.documents,
    waitNote: null,
    secondaries,
  };
}

/**
 * 입고 스캔(현장) 화면 맨 위 카드 — 현장이 지금 할 일 하나. 명세서 올리기·대조·마감은 사무실 일이라 여기 없다.
 * 링크는 모두 같은 화면 안(#앵커)이다.
 */
export function pickFieldNextStep(input: InboundNextStepInput): InboundNextStep {
  const { pendingDocuments, remainingBoxCount, needsCheckScanCount, firstNeedsCheckScanId } = input;

  const needsCheckLinks =
    needsCheckScanCount > 0
      ? [
          {
            label: `확인이 필요한 박스 ${needsCheckScanCount}개 보기`,
            href: firstNeedsCheckScanId ? `#scan-${firstNeedsCheckScanId}` : INBOUND_ANCHORS.history,
          },
        ]
      : [];

  if (pendingDocuments.length > 0 && remainingBoxCount > 0) {
    if (pendingDocuments.every((doc) => doc.scanFinished)) {
      return {
        key: "field-done",
        who: "현장",
        title: "스캔 종료를 알렸습니다",
        detail: `안 온 박스 ${remainingBoxCount}개는 사무실이 확인하고 마감합니다. 박스가 더 오면 아래 '스캔 다시 시작'을 누르고 이어서 찍으세요.`,
        buttonLabel: "스캔 화면으로",
        href: INBOUND_ANCHORS.scanForm,
        waitNote: { who: "사무실", text: "사무실이 안 온 물건을 확인하는 중입니다." },
        secondaries: needsCheckLinks,
      };
    }

    return {
      key: "field-scan",
      who: "현장",
      title: `박스 ${remainingBoxCount}개를 더 찍어 주세요`,
      detail: "명세서 기준으로 아직 안 들어온 박스입니다. 다 찍었는데 남았으면 사무실에 알려 주세요.",
      buttonLabel: "박스 스캔하기",
      href: INBOUND_ANCHORS.scanForm,
      waitNote: null,
      secondaries: needsCheckLinks,
    };
  }

  if (pendingDocuments.length > 0) {
    if (needsCheckScanCount > 0) {
      return {
        key: "field-done",
        who: "현장",
        title: "명세서의 박스를 모두 찍었습니다",
        detail: `상품 확인이 필요한 박스 ${needsCheckScanCount}개는 재고에 아직 안 들어갔습니다. 상품을 지정해 주세요.`,
        buttonLabel: "상품 지정하러 가기",
        href: firstNeedsCheckScanId ? `#scan-${firstNeedsCheckScanId}` : INBOUND_ANCHORS.history,
        waitNote: { who: "사무실", text: "이후 사무실이 명세서와 맞춰 보고 마감합니다." },
        secondaries: [],
      };
    }

    return {
      key: "field-done",
      who: "현장",
      title: "명세서의 박스를 모두 찍었습니다",
      detail: "스캔은 끝났습니다. 이제 사무실이 명세서와 맞춰 보고 마감합니다.",
      buttonLabel: "박스 더 스캔하기",
      href: INBOUND_ANCHORS.scanForm,
      waitNote: { who: "사무실", text: "사무실이 확인하는 중입니다." },
      secondaries: [],
    };
  }

  return {
    key: "field-start",
    who: "현장",
    title: "박스의 바코드를 스캔하세요",
    detail: "명세서 없이 스캔해도 바로 재고에 반영됩니다. 사무실이 명세서를 올려 두면 저절로 맞춰집니다.",
    buttonLabel: "스캔 시작",
    href: INBOUND_ANCHORS.scanForm,
    waitNote: null,
    secondaries: needsCheckLinks,
  };
}
