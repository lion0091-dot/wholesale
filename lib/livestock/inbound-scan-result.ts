/**
 * 입고 스캔 한 건을 등록한 직후 화면에 띄우는 "결과 카드"의 판단 로직.
 *
 * 색 세 가지 — green: 끝 / yellow: 입고는 됐지만 확인이 필요 / red: 사람이 처리해야 재고가 잡힘.
 * 한 박스에 여러 사정이 겹치면(예: 무게 차이 + 유통기한 임박) 가장 심각한 것이 제목이 되고 나머지는 덧붙인다.
 * 화면(inbound-scan-view.tsx)은 이 결과를 그리기만 한다.
 */

export type ResultTone = "green" | "yellow" | "red";

export interface ScanResultInput {
  scanId: string;
  status: "NORMAL" | "PENDING_MAPPING" | "EXCEPTION";
  bestBefore: string | null;
  daysLeft: number | null;
  labeledWeight: number | null;
  weightVariance: number | null;
  varianceRatio: number | null;
  varianceExceeded: boolean;
  purchaseUnitPrice: number | null;
  purchaseAmount: number | null;
  autoCreated: { productName: string; needsPrice: boolean } | null;
  failReason: "API_ERROR" | "NOT_FOUND" | null;
  failDetail: string | null;
  failIsNotConfigured: boolean;
  productConflict: { gtinProductId: string; documentProductId: string } | null;
}

export interface ScanResultOptions {
  /** 원가(매입단가)는 관리자만 본다 — 직원에게는 금액을 안 보여준다. */
  canSeePrice: boolean;
  actualWeight: number;
  productName: (id: string) => string;
  formatWon: (value: number) => string;
  formatVariance: (variance: number, ratio: number) => string;
}

export interface ResultIssue {
  tone: ResultTone;
  title: string;
  detail: string;
  /** 같은 화면 안 이동("#…") 또는 다른 화면 경로. */
  action?: { label: string; href: string };
}

export interface ResultCard {
  tone: ResultTone;
  title: string;
  detail: string;
  /** 제목 말고 함께 알려야 할 다른 사정들. */
  extras: Array<{ tone: ResultTone; title: string; detail: string }>;
  action: { label: string; href: string } | null;
}

const TONE_RANK: Record<ResultTone, number> = { red: 0, yellow: 1, green: 2 };

function failureIssue(data: ScanResultInput, scanId: string): ResultIssue {
  const jump = { label: "이 박스로 이동", href: `#scan-${scanId}` };

  if (data.failIsNotConfigured) {
    return {
      tone: "red",
      title: "이력 조회 기능이 설정되지 않아 확인하지 못했습니다",
      detail:
        "인증키가 아직 등록되지 않았습니다. 다시 찍어도 지금은 통과하지 않습니다. 입고는 기록됐으니 아래 목록에서 상품을 직접 지정하면 재고가 잡힙니다.",
      action: jump,
    };
  }

  if (data.failReason === "API_ERROR") {
    return {
      tone: "red",
      title: "이력 조회 중 오류가 있었습니다",
      detail:
        `${data.failDetail ? `(${data.failDetail}) ` : ""}일시적일 수 있으니 한 번 더 찍어 보세요. ` +
        "계속 안 되면 아래 목록에서 상품을 직접 지정하세요.",
      action: jump,
    };
  }

  return {
    tone: "red",
    title: "이 번호는 이력에서 확인되지 않았습니다",
    detail:
      "바코드를 다시 확인해 보세요. 번호가 맞다면 아래 목록에서 상품을 직접 지정하면 재고가 잡힙니다. " +
      "여러 품목이 섞인 공급처 박스 바코드라면 \"박스 나눠서 입고\"를 쓰세요.",
    action: jump,
  };
}

export function buildScanResultCard(data: ScanResultInput, options: ScanResultOptions): ResultCard {
  const issues: ResultIssue[] = [];

  if (data.status === "EXCEPTION") {
    issues.push(failureIssue(data, data.scanId));
  } else if (data.status === "PENDING_MAPPING") {
    issues.push({
      tone: "red",
      title: "상품을 한 번만 지정해 주세요",
      detail: "부위를 알 수 없어 자동으로 등록되지 않았습니다. 아래 목록에서 상품을 지정하면 그때 재고가 늘어납니다.",
      action: { label: "이 박스로 이동", href: `#scan-${data.scanId}` },
    });
  }

  if (data.daysLeft !== null && data.daysLeft < 0) {
    issues.push({
      tone: "yellow",
      title: `유통기한이 ${-data.daysLeft}일 지난 박스입니다`,
      detail: `(${data.bestBefore}) 입고는 기록했지만 출고되지 않습니다.`,
    });
  } else if (data.daysLeft !== null && data.daysLeft <= 3) {
    issues.push({
      tone: "yellow",
      title: `유통기한이 ${data.daysLeft}일 남았습니다`,
      detail: `(${data.bestBefore}) 먼저 내보내세요.`,
    });
  }

  if (data.varianceExceeded && data.weightVariance !== null && data.varianceRatio !== null) {
    issues.push({
      tone: "yellow",
      title: "표기중량과 실중량 차이가 큽니다",
      detail:
        `표기 ${data.labeledWeight}kg / 실측 ${options.actualWeight}kg — ` +
        `${options.formatVariance(data.weightVariance, data.varianceRatio)}. ` +
        "입고는 실중량으로 기록했습니다. 매입처에 확인하세요.",
    });
  }

  if (data.productConflict) {
    issues.push({
      tone: "yellow",
      title: "바코드 상품과 명세서 상품이 다릅니다",
      detail:
        `바코드 상품코드는 '${options.productName(data.productConflict.gtinProductId)}', ` +
        `명세서는 '${options.productName(data.productConflict.documentProductId)}'입니다. ` +
        "바코드 기준으로 입고했습니다. 아래 목록에서 어느 쪽이 맞는지 확인하세요.",
    });
  }

  if (data.autoCreated) {
    issues.push({
      tone: "yellow",
      title: `'${data.autoCreated.productName}' 상품을 새로 만들어 입고했습니다`,
      detail: "새 상품은 판매중지 상태입니다. 상품 관리에서 판매가를 넣고 '판매중'으로 바꿔야 고객에게 보입니다.",
      action: { label: "상품 관리로", href: "/dashboard/products" },
    });
  }

  if (issues.length === 0) {
    const amountKnown = data.purchaseAmount !== null;

    return {
      tone: "green",
      title: "입고 완료 — 재고에 반영됐습니다",
      detail: !options.canSeePrice
        ? "다음 박스를 찍으세요."
        : amountKnown
          ? `매입 ${options.formatWon(data.purchaseAmount as number)} ` +
            `(실중량 ${options.actualWeight}kg × ${options.formatWon(data.purchaseUnitPrice ?? 0)})로 기록했습니다.`
          : "매입단가가 없어 금액은 비워 뒀습니다. 관리자가 매입 정산 화면에서 채울 수 있습니다.",
      extras: [],
      action: null,
    };
  }

  const sorted = [...issues].sort((left, right) => TONE_RANK[left.tone] - TONE_RANK[right.tone]);
  const [primary, ...rest] = sorted;

  return {
    tone: primary.tone,
    title: primary.title,
    detail: primary.detail,
    extras: rest.map(({ tone, title, detail }) => ({ tone, title, detail })),
    action: primary.action ?? null,
  };
}

/** 입고 등록 전에 입력이 비었을 때의 카드 — 어느 칸을 채워야 하는지 알려 준다. */
export function buildMissingInputCard(field: "trace" | "weight"): ResultCard {
  return {
    tone: "red",
    title: field === "trace" ? "이력번호를 입력하세요" : "저울에 찍힌 실중량을 입력하세요",
    detail:
      field === "trace"
        ? "바코드를 스캐너로 찍거나 이력번호를 직접 입력하면 됩니다. 파란 테두리 칸입니다."
        : "재고와 매입금액은 저울에 찍힌 실중량으로 계산됩니다. 파란 테두리 칸에 적어 주세요.",
    extras: [],
    action: null,
  };
}

/** 등록 요청 자체가 실패했을 때(권한·서버 오류 등). */
export function buildFailureCard(message: string): ResultCard {
  return {
    tone: "red",
    title: "입고를 등록하지 못했습니다",
    detail: message,
    extras: [],
    action: null,
  };
}

/** 명세서 대조 결과를 결과 카드에 덧붙인다 — 명세서에 없는 번호이거나, 명세서 없이 입고한 경우. */
export function withDocumentContext(
  card: ResultCard,
  context: { hasPendingDocument: boolean; documentMatched: boolean | null },
): ResultCard {
  if (context.hasPendingDocument && context.documentMatched === false) {
    return {
      ...card,
      tone: card.tone === "green" ? "yellow" : card.tone,
      extras: [
        ...card.extras,
        {
          tone: "yellow",
          title: "명세서에 없는 번호입니다",
          detail: "이 박스는 대기 중인 명세서의 어느 줄과도 이어지지 않았습니다. 입고는 그대로 기록됐고, 대조 화면에서 확인할 수 있습니다.",
        },
      ],
    };
  }

  if (!context.hasPendingDocument && card.tone === "green") {
    return {
      ...card,
      extras: [
        ...card.extras,
        {
          tone: "green",
          title: "명세서 없이 입고했습니다",
          detail: "나중에 이 공급처의 명세서를 올리면 이 박스가 자동으로 이어집니다.",
        },
      ],
    };
  }

  return card;
}
