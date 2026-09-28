/**
 * 입고 스캔(현장) 화면 맨 위 "지금 할 일" 카드의 판단 로직.
 *
 * 화면(서버 컴포넌트)이 이미 읽은 데이터만 받아 다음에 할 일 하나를 고른다.
 */

export interface InboundNextStepInput {
  /** 이력 확인 필요·상품 확인 필요 상태로 남은 박스 수. */
  needsCheckScanCount: number;
  /** 그 중 가장 최근 박스 — 카드 버튼이 내역 맨 위가 아니라 이 박스로 바로 이동한다. */
  firstNeedsCheckScanId?: string | null;
}

export type InboundNextStepKey = "field-check" | "field-start";

export interface InboundNextStep {
  key: InboundNextStepKey;
  /** 이 단계를 하는 사람 — 지금은 입고 스캔 화면뿐이라 항상 "현장". */
  who: "사무실" | "현장";
  title: string;
  detail: string | null;
  buttonLabel: string;
  /** true면 누를 수 없는 대기 표시. */
  buttonDisabled?: boolean;
  /** "#id"는 같은 화면 안 이동, "/"로 시작하면 다른 화면. */
  href: string;
  /** 이 단계를 하지 않는 쪽에게 "지금은 기다리면 된다"고 알리는 안내. */
  waitNote: { who: "사무실" | "현장"; text: string } | null;
  /** 큰 버튼 아래 작은 링크들. */
  secondaries: Array<{ label: string; href: string }>;
}

/**
 * "여기를 보세요"로 강조할 카드 — 사람이 지금 손을 대야 진행되는 일(확인 필요 박스 처리)만.
 * 처음 시작 상태(스캔 시작)는 강조하지 않는다 — 다 강조하면 강조가 아니다.
 */
const ATTENTION_STEP_KEYS: ReadonlySet<InboundNextStepKey> = new Set<InboundNextStepKey>(["field-check"]);

export function needsAttention(step: Pick<InboundNextStep, "key" | "buttonDisabled">): boolean {
  return ATTENTION_STEP_KEYS.has(step.key) && !step.buttonDisabled;
}

export const INBOUND_ANCHORS = {
  /** "지금 할 일" 카드 — 종 배지가 여기로 바로 보낸다. */
  nextStep: "#inbound-next-step",
  scanForm: "#inbound-scan-form",
  history: "#inbound-history",
  /** 입고 스캔 화면의 "확인이 필요한 박스" 목록(처리 안 끝난 박스만). */
  unresolved: "#inbound-unresolved",
} as const;

export const INBOUND_SCAN_PATH = "/dashboard/inbound";
/** 발주서에 없거나 초과로 받은 박스가 쌓이는 곳 — 재고엔 이미 들어가 있어 급하진 않지만, 카드가 안 알려주면 사무실이 잊는다. */
export const INBOUND_HOLDS_PATH = "/dashboard/inbound/holds";

const scanBoxLink = (scanId: string) => `${INBOUND_SCAN_PATH}#scan-${scanId}`;

/**
 * 입고 스캔(현장) 화면 맨 위 카드 — 지금 할 일 하나.
 * 확인이 필요한 박스(이력 못 찾음·상품 미확정)는 재고에 안 들어가 있다 — 이 화면에서 가장 먼저 할 일이다.
 * 카드 하나만 "지금 할 일"을 말해야 사용자가 어느 안내를 따를지 고민하지 않는다.
 */
export function pickFieldNextStep(input: InboundNextStepInput): InboundNextStep {
  const { needsCheckScanCount, firstNeedsCheckScanId } = input;

  if (needsCheckScanCount > 0) {
    return {
      key: "field-check",
      who: "현장",
      title: `확인이 필요한 박스 ${needsCheckScanCount}개를 먼저 처리하세요`,
      detail:
        "이 박스들은 아직 재고에 안 들어갔습니다. 아래 '확인이 필요한 박스'에서 그 박스 옆의 '상품 지정'을 하세요(이력 못 찾음이면 '번호 바꾸기'). 다 처리하면 이 안내가 사라집니다. 새 박스는 그다음에 찍으세요.",
      buttonLabel: "확인 필요 박스로 가기",
      href: firstNeedsCheckScanId ? `#scan-${firstNeedsCheckScanId}` : INBOUND_ANCHORS.unresolved,
      waitNote: null,
      secondaries: [{ label: "처리 전에 새 박스를 먼저 찍기", href: INBOUND_ANCHORS.scanForm }],
    };
  }

  return {
    key: "field-start",
    who: "현장",
    title: "박스의 바코드를 스캔하세요",
    detail: "찍으면 재고에 바로 들어갑니다.",
    buttonLabel: "스캔 시작",
    href: INBOUND_ANCHORS.scanForm,
    waitNote: null,
    secondaries: [],
  };
}
