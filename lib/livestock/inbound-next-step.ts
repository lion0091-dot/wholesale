/**
 * 입고 화면 맨 위 "지금 할 일" 카드의 판단 로직.
 *
 * 화면(서버 컴포넌트)이 이미 읽은 데이터만 받아 다음에 할 일 하나를 고른다 — 고정된 1→2→3 순서가 아니라
 * 현재 상태를 보고 고르므로, 전표는 사무실이 올리고 스캔은 현장이 하는 식으로 나뉘어도 맞는다.
 * 전표 없이 스캔만으로 끝나는 길은 그대로 유지한다.
 */

export interface InboundNextStepInput {
  /** 대기(PENDING) 전표 — 오래된 것부터. completeLines/totalLines는 줄 상태 요약. */
  pendingDocuments: Array<{
    id: string;
    /** 공급처 이름 — 전표가 여러 장일 때 카드가 어느 전표인지 말해 주는 데 쓴다. */
    supplierName?: string | null;
    /** 현장이 스캔 종료를 표시했는가. */
    scanFinished?: boolean;
    completeLines: number;
    totalLines: number;
    /** 전표에 이어졌지만 상품이 안 정해져(이력 확인 필요 등) 재고에 아직 안 들어간 박스 수. */
    unresolvedBoxes?: number;
    /** 그 중 첫 박스 — 카드 버튼이 이 박스로 바로 이동한다. */
    firstUnresolvedScanId?: string | null;
  }>;
  /**
   * 전표 기준으로 아직 안 들어온 박스 수 — 박스가 하나도 안 온 줄은 예정 수량만큼, 일부만 온 줄은
   * 모자란 만큼 센다(수량 2인 줄에 1박스만 왔으면 1개가 남는다).
   */
  remainingBoxCount: number;
  /** 위 수 중 무게 기준 줄의 몫(덜 찬 줄마다 1). 문구가 "박스 N개"와 "전표무게보다 작은무게인 명세내역 M개"를 나눠 말한다. */
  remainingWeightLines?: number;
  /** 이력 확인 필요·상품 확인 필요 상태로 남은 박스 수. */
  needsCheckScanCount: number;
  /** 그 중 가장 최근 박스 — 카드 버튼이 내역 맨 위가 아니라 이 박스로 바로 이동한다. */
  firstNeedsCheckScanId?: string | null;
  /** 마감된 전표에 뒤늦게 온 박스 — 어느 줄에도 안 이어져 있고, 전표를 다시 열어야 이을 수 있다. */
  lateBoxes?: Array<{ scanId: string; documentId: string }>;
  /**
   * 대기 전표의 줄과 번호가 맞는데 자동으로 안 이어진 박스(같은 번호가 대기 전표 두 장에 있는 경우 등).
   * 박스는 이미 왔으니 "스캔 중이니 기다리세요"가 아니라 사무실이 대조 화면에서 이어야 한다.
   */
  unlinkedOpenBoxes?: Array<{ scanId: string; documentId: string }>;
}

export type InboundNextStepKey =
  | "scan"
  | "scan-finished"
  | "reconcile"
  | "close"
  | "upload"
  | "field-check"
  | "field-scan"
  | "field-done"
  | "field-start";

export interface InboundNextStep {
  key: InboundNextStepKey;
  /** 이 단계를 하는 사람 — 전표는 사무실, 박스 스캔은 현장. */
  who: "사무실" | "현장";
  title: string;
  detail: string | null;
  buttonLabel: string;
  /** true면 누를 수 없는 대기 표시 — 사무실이 현장 스캔을 기다리는 단계. */
  buttonDisabled?: boolean;
  /** 있으면 큰 버튼이 이동이 아니라 이 전표를 바로 마감한다(모든 줄이 맞고 재고도 다 반영된 경우). */
  closeDocumentId?: string;
  /** "#id"는 같은 화면 안 이동, "/"로 시작하면 다른 화면(입고 스캔 ↔ 전표입력). */
  href: string;
  /** 이 단계를 하지 않는 쪽에게 "지금은 기다리면 된다"고 알리는 안내. */
  waitNote: { who: "사무실" | "현장"; text: string } | null;
  /** 큰 버튼 아래 작은 링크들 — 전표 없이 바로 스캔하는 길, 확인이 필요한 박스 보기. */
  secondaries: Array<{ label: string; href: string }>;
}

/**
 * 아직 안 온 것을 말하는 문구 조각. 박스 수 기준 줄은 "박스 N개", 무게 기준 줄(개체번호 줄 등)은
 * 몇 박스로 나뉘어 올지 몰라 "전표무게보다 작은무게인 명세내역 M개"로 말한다.
 */
export function describeRemaining(remainingBoxCount: number, remainingWeightLines = 0): string {
  const weightLines = Math.min(remainingWeightLines, remainingBoxCount);
  const boxes = remainingBoxCount - weightLines;

  if (weightLines === 0) return `박스 ${remainingBoxCount}개`;
  if (boxes === 0) return `전표무게보다 작은무게인 명세내역 ${weightLines}개`;

  return `박스 ${boxes}개와 전표무게보다 작은무게인 명세내역 ${weightLines}개`;
}

/**
 * "여기를 보세요"로 강조할 카드 — 사람이 지금 손을 대야 진행되는 일(확인 필요 박스 처리·전표 대조·마감)만.
 * 처음 시작 상태(전표 올리기·스캔 시작)·기다림·"전부 찍었습니다" 같은 안내는 강조하지 않는다 — 다 강조하면 강조가 아니다.
 */
const ATTENTION_STEP_KEYS: ReadonlySet<InboundNextStepKey> = new Set<InboundNextStepKey>(["field-check", "reconcile", "close", "scan-finished"]);

export function needsAttention(step: Pick<InboundNextStep, "key" | "buttonDisabled">): boolean {
  return ATTENTION_STEP_KEYS.has(step.key) && !step.buttonDisabled;
}

export const INBOUND_ANCHORS = {
  nextStep: "#inbound-next-step",
  documents: "#inbound-documents",
  scanForm: "#inbound-scan-form",
  history: "#inbound-history",
  scanFinish: "#inbound-scan-finish",
} as const;

/** 입고는 두 화면이다 — 현장이 쓰는 입고 스캔, 사무실이 쓰는 전표입력(전표 올리기·대조·마감). */
export const INBOUND_SCAN_PATH = "/dashboard/inbound";
export const INBOUND_STATEMENTS_PATH = "/dashboard/inbound/statements";

/** 전표입력 화면에서 입고 스캔 화면의 칸으로 가는 링크(다른 화면이라 경로를 붙인다). */
const SCAN_FORM_LINK = `${INBOUND_SCAN_PATH}${INBOUND_ANCHORS.scanForm}`;
const SCAN_HISTORY_LINK = `${INBOUND_SCAN_PATH}${INBOUND_ANCHORS.history}`;
const scanBoxLink = (scanId: string) => `${INBOUND_SCAN_PATH}#scan-${scanId}`;

/** 카드 버튼이 전표 올리기 칸으로 이동할 때 접혀 있는 칸을 함께 열도록 알리는 창 이벤트 이름. */
export const OPEN_DOCUMENT_PANEL_EVENT = "inbound:open-document-panel";

export function documentReconcileHref(documentId: string): string {
  return `/dashboard/inbound/documents/${documentId}`;
}

/** 대조 화면을 열자마자 마감 창까지 열어 준다(사유 적고 마감만 누르면 끝). */
function documentCloseHref(documentId: string): string {
  return `${documentReconcileHref(documentId)}#close`;
}

/** 대조 화면에서 그 박스가 든 줄을 펼치고 박스 자리로 데려간다. */
function documentBoxHref(documentId: string, scanId: string): string {
  return `${documentReconcileHref(documentId)}#box-${scanId}`;
}

/** 전표가 여러 장이면 카드 문장 앞에 공급처를 붙여 어느 전표 이야기인지 알린다. */
function withSupplier(
  detail: string,
  doc: { supplierName?: string | null },
  pendingCount: number
): string {
  return pendingCount > 1 && doc.supplierName ? `[${doc.supplierName}] ${detail}` : detail;
}

/** 대조가 필요한 전표로 안내한다 — 줄이 다 맞은 전표가 아니라 안 온 박스가 남은 쪽이어야 사무실이 바로 처리한다. */
function pickAttentionDocument(docs: InboundNextStepInput["pendingDocuments"]) {
  return docs.find((doc) => doc.completeLines < doc.totalLines) ?? docs[0];
}

/** 사무실 카드: 다음 할 일 하나에, 마감된 전표 뒤에 온 박스가 있으면 그 전표로 가는 링크를 작은 링크로 덧붙인다. */
export function pickInboundNextStep(input: InboundNextStepInput): InboundNextStep {
  const step = pickOfficeStep(input);
  const late = input.lateBoxes ?? [];

  if (late.length === 0) return step;

  // 대기 전표가 없어 카드가 "먼저 전표를 올리세요"뿐이면, 이미 와 있는 박스 처리가 더 급하다 — 종 배지에서 넘어온 사람이
  // 작은 링크를 찾지 않아도 되게 큰 버튼으로 올린다.
  if (step.key === "upload") {
    return {
      key: "reconcile",
      who: "사무실",
      title: "마감된 전표 뒤에 박스가 왔습니다",
      detail: `박스 ${late.length}개가 이미 마감된 전표의 번호와 같습니다. 그 전표를 다시 열어 박스를 이어 주세요. 더 온 이유를 적고 다시 마감하면 끝입니다.`,
      waitNote: null,
      buttonLabel: "전표 다시 열러 가기",
      href: documentReconcileHref(late[0].documentId),
      // 원래 카드의 작은 링크(전표 없이 스캔, 확인이 필요한 박스 보기)는 그대로 남긴다 — 길이 하나도 사라지지 않게.
      secondaries: [{ label: "새 전표 올리기", href: INBOUND_ANCHORS.documents }, ...step.secondaries],
    };
  }

  return {
    ...step,
    secondaries: [
      ...step.secondaries,
      {
        label: `마감된 전표 뒤에 온 박스 ${late.length}개 — 전표를 다시 열어 이어 주세요`,
        href: documentReconcileHref(late[0].documentId),
      },
    ],
  };
}

function pickOfficeStep(input: InboundNextStepInput): InboundNextStep {
  const { pendingDocuments, remainingBoxCount, needsCheckScanCount, firstNeedsCheckScanId } = input;
  const remainingText = describeRemaining(remainingBoxCount, input.remainingWeightLines);

  const unlinkedOpen = input.unlinkedOpenBoxes ?? [];

  if (pendingDocuments.length > 0 && unlinkedOpen.length > 0) {
    return {
      key: "reconcile",
      who: "사무실",
      title: "이미 온 박스가 전표에 이어지지 않았습니다",
      detail: `박스 ${unlinkedOpen.length}개가 어느 줄에도 안 이어졌습니다(같은 번호가 전표 여러 장에 있을 수 있습니다). 맞춰 보기에서 알맞은 줄에 이어 주세요.`,
      waitNote: { who: "현장", text: "사무실이 박스를 전표에 이어 주는 중입니다. 스캔은 계속하셔도 됩니다." },
      buttonLabel: "맞춰 보기",
      href: documentReconcileHref(unlinkedOpen[0].documentId),
      secondaries: [],
    };
  }

  if (pendingDocuments.length > 0) {
    if (remainingBoxCount > 0 && pendingDocuments.every((doc) => doc.scanFinished)) {
      // 박스가 끝내 다 안 왔다고 현장이 알렸다 — 안 온 물건을 사유와 함께 남기고 마감하는 단계다.
      return {
        key: "scan-finished",
        who: "사무실",
        title: "현장 스캔이 종료됐습니다",
        detail: withSupplier(`안 온 것: ${remainingText}. 사유를 적고 마감하세요.`, pickAttentionDocument(pendingDocuments), pendingDocuments.length),
        waitNote: { who: "현장", text: "스캔 종료를 알렸습니다. 박스가 더 오면 그냥 찍으세요 — 저절로 다시 시작됩니다." },
        buttonLabel: "확인·마감하기",
        href: documentCloseHref(pickAttentionDocument(pendingDocuments).id),
        secondaries: [{ label: "현장: 스캔 화면으로 이동", href: SCAN_FORM_LINK }],
      };
    }

    if (remainingBoxCount > 0) {
      return {
        key: "scan",
        who: "사무실",
        title: "현장에서 스캔 중입니다",
        detail: `아직 안 들어온 것: ${remainingText}. 오는 중이면 기다려 주세요. 끝내 안 오는 물건이면 아래 "확인·마감하기"를 누르세요.`,
        waitNote: null,
        buttonLabel: "스캔 중 대기",
        buttonDisabled: true,
        href: SCAN_FORM_LINK,
        secondaries: [
          { label: "현장: 스캔 화면으로 이동", href: SCAN_FORM_LINK },
          // 공급처가 물건을 덜 보냈으면 박스는 끝내 다 안 온다 — 이때는 안 온 물건을 사유와 함께 남기고 마감한다.
          { label: "박스가 다 안 왔어도 확인·마감하기 (사무실)", href: documentCloseHref(pickAttentionDocument(pendingDocuments).id) },
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
        detail: withSupplier(`맞춰 볼 줄 ${lineCount}개`, unfinished[0], pendingDocuments.length),
        waitNote: { who: "현장", text: "스캔은 끝났습니다. 사무실이 전표와 맞춰 보는 중입니다." },
        buttonLabel: "맞춰 보기",
        href: documentReconcileHref(unfinished[0].id),
        secondaries: [],
      };
    }

    const unresolved = pendingDocuments.reduce((sum, doc) => sum + (doc.unresolvedBoxes ?? 0), 0);
    const unresolvedDocument = pendingDocuments.find((doc) => (doc.unresolvedBoxes ?? 0) > 0) ?? pendingDocuments[0];

    if (unresolved > 0) {
      return {
        key: "close",
        who: "사무실",
        title: "전부 도착했습니다",
        detail: `상품이 안 정해진 박스 ${unresolved}개는 재고에 아직 안 들어갔습니다. 버튼을 눌러 그 박스에서 상품을 지정하세요.`,
        waitNote: null,
        buttonLabel: "상품 지정하러 가기",
        href: unresolvedDocument.firstUnresolvedScanId
          ? documentBoxHref(unresolvedDocument.id, unresolvedDocument.firstUnresolvedScanId)
          : documentReconcileHref(unresolvedDocument.id),
        secondaries: [{ label: "그래도 마감하기", href: documentCloseHref(unresolvedDocument.id) }],
      };
    }

    return {
      key: "close",
      who: "사무실",
      title: "전부 입고 완료되었습니다",
      detail: withSupplier("재고에 모두 반영됐습니다. 마감하면 끝입니다.", pendingDocuments[0], pendingDocuments.length),
      waitNote: { who: "현장", text: "스캔은 끝났습니다. 사무실이 마감하면 이 전표는 끝납니다." },
      buttonLabel: "마감하기",
      closeDocumentId: pendingDocuments[0].id,
      href: documentReconcileHref(pendingDocuments[0].id),
      secondaries: [],
    };
  }

  // 대기 전표가 없으면 다음 할 일은 언제나 전표 올리기다. 남아 있는 확인 필요 박스(상품이 정해지지
  // 않으면 재고에 안 들어간다)는 숨기지 않고 작은 링크로 옆에 둔다.
  const secondaries: Array<{ label: string; href: string }> = [
    { label: "전표 없이 바로 스캔", href: SCAN_FORM_LINK },
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
    title: "먼저 전표를 올리세요",
    detail: "공급처 전표가 있으면 박스를 찍을 때 자동으로 맞춰 줍니다",
    buttonLabel: "전표 올리기",
    href: INBOUND_ANCHORS.documents,
    waitNote: null,
    secondaries,
  };
}

/**
 * 입고 스캔(현장) 화면 맨 위 카드 — 현장이 지금 할 일 하나. 전표 올리기·대조·마감은 사무실 일이라 여기 없다.
 * 링크는 모두 같은 화면 안(#앵커)이다.
 */
export function pickFieldNextStep(input: InboundNextStepInput): InboundNextStep {
  const { pendingDocuments, remainingBoxCount, needsCheckScanCount, firstNeedsCheckScanId } = input;
  const remainingText = describeRemaining(remainingBoxCount, input.remainingWeightLines);

  // 확인이 필요한 박스(이력 못 찾음·상품 미확정)는 재고에 안 들어가 있고 전표 마감도 막는다 — 이 화면에서 가장 먼저 할 일이다.
  // 카드 하나만 "지금 할 일"을 말해야 사용자가 어느 안내를 따를지 고민하지 않는다.
  if (needsCheckScanCount > 0) {
    return {
      key: "field-check",
      who: "현장",
      title: `확인이 필요한 박스 ${needsCheckScanCount}개를 먼저 처리하세요`,
      detail:
        "이 박스들은 아직 재고에 안 들어갔습니다. 입고 내역의 그 박스 옆에서 '상품 지정'을 하세요(이력 못 찾음이면 '번호 바꾸기'). 다 처리하면 이 안내가 다음 할 일로 바뀝니다. 새 박스는 그다음에 찍으세요.",
      buttonLabel: "확인 필요 박스로 가기",
      href: firstNeedsCheckScanId ? `#scan-${firstNeedsCheckScanId}` : INBOUND_ANCHORS.history,
      waitNote: null,
      secondaries: [{ label: "처리 전에 새 박스를 먼저 찍기", href: INBOUND_ANCHORS.scanForm }],
    };
  }

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
        detail: `안 온 것(${remainingText})은 사무실이 확인합니다. 박스가 더 오면 그냥 찍으세요 — 저절로 다시 시작됩니다.`,
        buttonLabel: "스캔 화면으로",
        href: INBOUND_ANCHORS.scanForm,
        waitNote: { who: "사무실", text: "사무실이 안 온 물건을 확인하는 중입니다." },
        secondaries: needsCheckLinks,
      };
    }

    return {
      key: "field-scan",
      who: "현장",
      title: (input.remainingWeightLines ?? 0) > 0 ? `더 찍어 주세요 — ${remainingText}` : `박스 ${remainingBoxCount}개를 더 찍어 주세요`,
      detail: "다 찍었는데 남았으면 '스캔 종료'를 누르세요. 사무실이 안 온 물건을 처리합니다.",
      buttonLabel: "박스 스캔하기",
      href: INBOUND_ANCHORS.scanForm,
      waitNote: null,
      secondaries: [{ label: "스캔 종료 누르러 가기", href: INBOUND_ANCHORS.scanFinish }, ...needsCheckLinks],
    };
  }

  if (pendingDocuments.length > 0) {
    if (needsCheckScanCount > 0) {
      return {
        key: "field-done",
        who: "현장",
        title: "전표의 박스를 모두 찍었습니다",
        detail: `상품 확인이 필요한 박스 ${needsCheckScanCount}개는 재고에 아직 안 들어갔습니다. 상품을 지정하세요.`,
        buttonLabel: "상품 지정하러 가기",
        href: firstNeedsCheckScanId ? `#scan-${firstNeedsCheckScanId}` : INBOUND_ANCHORS.history,
        waitNote: { who: "사무실", text: "이후 사무실이 전표와 맞춰 보고 마감합니다." },
        secondaries: [],
      };
    }

    return {
      key: "field-done",
      who: "현장",
      title: "전표의 박스를 모두 찍었습니다",
      detail: "다 찍었습니다. 사무실이 마감합니다.",
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
    detail: "전표 없이 찍어도 재고에 바로 들어갑니다.",
    buttonLabel: "스캔 시작",
    href: INBOUND_ANCHORS.scanForm,
    waitNote: null,
    secondaries: needsCheckLinks,
  };
}
