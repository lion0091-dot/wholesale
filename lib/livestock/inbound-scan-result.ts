/**
 * 입고 스캔 한 건을 등록한 직후 화면에 띄우는 "결과 카드"의 판단 로직.
 *
 * 색 세 가지 — green: 끝 / yellow: 입고는 됐지만 확인이 필요 / red: 사람이 처리해야 재고가 잡힘.
 * 한 박스에 여러 사정이 겹치면(예: 무게 차이 + 유통기한 임박) 가장 심각한 것이 제목이 되고 나머지는 덧붙인다.
 * 화면(inbound-scan-view.tsx)은 이 결과를 그리기만 한다.
 */

import { rejectionSummary, type ScanPurchaseOrder } from "./scan-purchase-order";

export type ResultTone = "green" | "yellow" | "red";

export interface ScanResultInput {
  scanId: string;
  status: "NORMAL" | "PENDING_MAPPING" | "EXCEPTION" | "REJECTED";
  productId?: string | null;
  /** 거래처를 싣고 찍은 박스의 발주서 판정(없으면 null·생략). */
  po?: ScanPurchaseOrder | null;
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
        "인증키가 아직 등록되지 않았습니다. 다시 찍어도 지금은 통과하지 않습니다. 키가 등록되면 시스템이 자동으로 다시 조회합니다. 급하면 입고는 기록됐으니 아래 목록에서 상품을 직접 지정하면 재고가 잡힙니다.",
      action: jump,
    };
  }

  if (data.failReason === "API_ERROR") {
    return {
      tone: "red",
      title: "이력 조회 중 오류가 있었습니다",
      detail:
        `${data.failDetail ? `(${data.failDetail}) ` : ""}일시적일 수 있어 시스템이 몇 분 뒤 자동으로 다시 조회합니다. ` +
        "급하면 박스 옆 '다시 조회'를 누르거나 아래 목록에서 상품을 직접 지정하세요.",
      action: jump,
    };
  }

  return {
    tone: "red",
    title: "이 번호는 이력에서 확인되지 않았습니다",
    detail:
      "번호가 틀렸다면 박스 옆 '번호 바꾸기'로 바로잡으세요(무게는 그대로 옮겨집니다). " +
      "번호가 맞다면 이력에 등록되는 대로 시스템이 자동으로 다시 조회하고, 급하면 아래 목록에서 상품을 직접 지정하세요. " +
      "여러 품목이 섞인 공급처 박스 바코드라면 \"박스 분류입고\"를 쓰세요.",
    action: jump,
  };
}

function formatKg(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 3 });
}

/** 발주서 기준으로 받지 않은 박스 — 재고에 없다는 것과 다음에 할 일을 알린다. */
function buildRejectedCard(data: ScanResultInput, options: ScanResultOptions): ResultCard {
  const po = data.po;
  const name = data.productId ? `'${options.productName(data.productId)}' ` : "";

  return {
    tone: "red",
    title: po?.reason === "UNLISTED" ? "받지 않았습니다 — 이 거래처 전표에 없는 물건입니다" : "받지 않았습니다 — 발주 수량을 넘었습니다",
    detail:
      `${name}${po ? rejectionSummary(po) : "전표 기준으로 받지 않았습니다."} 재고에는 넣지 않았고 거절 기록만 남겼습니다. ` +
      "이 박스는 공급처와 상의해 돌려보내세요. 받기로 했다면 전표관리에서 품목·수량을 먼저 늘린 뒤 다시 찍으세요.",
    extras: [],
    action: { label: "전표관리로", href: "/dashboard/purchase-orders" },
  };
}

/** 발주서 판정을 결과 카드에 덧붙인다 — 어느 발주서에 붙었는지, 사무실이 할 일이 있는지. */
function addPurchaseOrderNotice(card: ResultCard, data: ScanResultInput): void {
  const po = data.po;

  if (!po) return;

  if (po.result === "ASSIGNED") {
    const progress =
      po.ordered !== null && po.received !== null
        ? `발주 ${formatKg(po.ordered)}kg 중 ${formatKg(po.received)}kg 받았습니다` +
          (po.remaining !== null && po.remaining > 0 ? ` (남음 ${formatKg(po.remaining)}kg).` : ".")
        : "전표에 붙었습니다.";

    card.extras.push({
      tone: "green",
      title: po.orderClosed ? "전표를 다 받아 자동으로 마감했습니다" : "전표에 붙었습니다",
      detail: progress,
    });
  } else if (po.result === "OVER_HELD") {
    if (card.tone === "green") card.tone = "yellow";

    const numbers =
      po.ordered !== null && po.received !== null
        ? ` 발주 ${formatKg(po.ordered)}kg 중 ${formatKg(po.received)}kg 받았고` +
          (po.excess !== null && po.excess > 0 ? `, ${formatKg(po.excess)}kg는 전표에 붙지 않았습니다.` : ".")
        : "";

    card.extras.push({
      tone: "yellow",
      title: "발주 수량을 넘었습니다",
      detail: `설정(입고 기준)에 따라 받아 두었습니다. 재고에는 들어가 판매할 수 있습니다.${numbers} 사무실이 확인해서 정리합니다.`,
    });
  } else if (po.result === "UNLISTED_HELD") {
    if (card.tone === "green") card.tone = "yellow";

    card.extras.push({
      tone: "yellow",
      title: "전표에 없는 물건입니다",
      detail: "설정(입고 기준)에 따라 받아 두었습니다. 사무실이 확인해서 정리합니다.",
    });
  }
}

export function buildScanResultCard(data: ScanResultInput, options: ScanResultOptions): ResultCard {
  if (data.status === "REJECTED") return buildRejectedCard(data, options);

  const card = buildCardWithoutClosedNotice(data, options);

  addPurchaseOrderNotice(card, data);

  return card;
}

function buildCardWithoutClosedNotice(data: ScanResultInput, options: ScanResultOptions): ResultCard {
  const issues: ResultIssue[] = [];

  if (data.status === "EXCEPTION") {
    issues.push(failureIssue(data, data.scanId));
  } else if (data.status === "PENDING_MAPPING") {
    issues.push({
      tone: "red",
      title: "상품을 한 번만 지정해 주세요",
      detail: "상품을 자동으로 정하지 못했습니다. 아래 목록에서 상품을 지정하면 그때 재고가 늘어납니다.",
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

  if (data.autoCreated) {
    issues.push({
      tone: "yellow",
      title: `'${data.autoCreated.productName}' 상품을 새로 만들어 입고했습니다`,
      detail: data.autoCreated.productName.includes("(부위 미지정)")
        ? "부위를 몰라 비워 뒀습니다. 상품 관리에서 부위를 채우고, 판매가를 넣은 뒤 '판매중'으로 바꾸세요."
        : "새 상품은 판매중지 상태입니다. 상품 관리에서 판매가를 넣고 '판매중'으로 바꿔야 고객에게 보입니다.",
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
export function buildMissingInputCard(field: "trace" | "weight" | "supplier"): ResultCard {
  if (field === "supplier") {
    return {
      tone: "red",
      title: "지금 온 거래처를 먼저 고르세요",
      detail: "어느 거래처 물건인지 알아야 전표와 맞춰 볼 수 있습니다. 위 '지금 온 거래처' 칸에서 고르면 다음 박스에도 그대로 남습니다.",
      extras: [],
      action: null,
    };
  }

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
