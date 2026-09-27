/**
 * 상품 관리 화면 맨 위 "지금 할 일" 카드의 판단 로직.
 *
 * 입고 화면(inbound-next-step.ts)과 같은 원칙 — 지금 동시에 여러 문제가 있어도 카드는 하나만
 * 강조한다("다 강조하면 강조가 아니다"). 나머지는 작은 링크로 아래에 둔다. 문제가 하나도 없으면
 * 카드 자체를 숨긴다(상품 관리는 입고처럼 항상 할 일이 있는 화면이 아니다).
 *
 * 우선순위(급한 순): 상품이 아예 없음(초기 설정) → 재입고했는데 발주가 안 풀림(매출 손실 중) →
 * 판매가 없어 고객에게 안 보임(매출 기회 막힘) → 부위가 비어 있음(관리 부정확) →
 * 핫딜 매진(정상 동작이지만 마무리 확인 필요) → 핫딜 매진 임박(정보성).
 */

export interface ProductsNextStepInput {
  /** 보관 제외 전체 상품 수. */
  totalCount: number;
  /** 재고 0으로 자동 발주정지됐고, 재입고돼도 저절로 안 풀리는 상품 수. */
  autoStoppedCount: number;
  /** 판매가가 없어 고객(미니샵)에 안 보이는 상품 수. */
  unpricedCount: number;
  /** 부위가 비어 있어 "(부위 미지정)"으로 표시되는 상품 수. */
  partlessCount: number;
  /** 핫딜 한도까지 다 팔려 기본가로 자동 전환된 상품 수. */
  hotDealReachedCount: number;
  /** 핫딜 한도 임박(설정한 기준 이하로 남음) 상품 수. */
  hotDealNearingCount: number;
}

export type ProductsNextStepKey =
  | "seed"
  | "auto-stopped"
  | "unpriced"
  | "partless"
  | "hot-deal-reached"
  | "hot-deal-nearing";

export interface ProductsNextStep {
  key: ProductsNextStepKey;
  title: string;
  detail: string;
  buttonLabel: string;
  href: string;
  secondaries: Array<{ label: string; href: string }>;
}

export const PRODUCTS_ANCHORS = {
  seed: "#products-seed",
  autoStopped: "#products-auto-stopped",
  priceBulk: "#products-price-bulk",
  hotDealReached: "#products-hotdeal-reached",
  hotDealNearing: "#products-hotdeal-nearing",
} as const;

/** 부위 미지정 상품만 걸러 보여주는 곳 — 상품 목록 자체(상태 필터 재사용, 보관함 딥링크와 같은 방식). */
export const PRODUCTS_PARTLESS_FILTER_PATH = "/dashboard/products?status=partless#product-table";

/** 판매가 일괄 등록 칸은 기본 접혀 있다 — 카드가 그 칸으로 보낼 때 펴 주는 신호. */
export const PRODUCTS_OPEN_PRICE_PANEL_EVENT = "products:open-price-panel";

interface Candidate {
  key: ProductsNextStepKey;
  count: number;
  title: string;
  detail: string;
  buttonLabel: string;
  href: string;
  /** 이 항목이 1순위가 아니라 작은 링크로 밀렸을 때 쓸 문구. */
  linkLabel: string;
}

function buildCandidates(input: ProductsNextStepInput): Candidate[] {
  return [
    {
      key: "auto-stopped",
      count: input.autoStoppedCount,
      title: `재입고됐는데도 발주가 막힌 상품이 ${input.autoStoppedCount}개 있습니다`,
      detail: "재고가 0이 되면 자동으로 발주가 멈추고, 다시 채워도 저절로 안 풀립니다. 지금 이대로면 고객이 주문할 수 없습니다 — 확인 후 직접 다시 여세요.",
      buttonLabel: "확인하러 가기",
      href: PRODUCTS_ANCHORS.autoStopped,
      linkLabel: `발주가 막힌 상품 ${input.autoStoppedCount}개 확인하기`,
    },
    {
      key: "unpriced",
      count: input.unpricedCount,
      title: `판매가가 없어 고객에게 안 보이는 상품이 ${input.unpricedCount}개 있습니다`,
      detail: "판매가를 채워야 미니샵에 노출됩니다. 한 번에 CSV로 내려받아 채워 올리세요.",
      buttonLabel: "판매가 채우러 가기",
      href: PRODUCTS_ANCHORS.priceBulk,
      linkLabel: `판매가 없는 상품 ${input.unpricedCount}개 채우기`,
    },
    {
      key: "partless",
      count: input.partlessCount,
      title: `부위가 비어 있는 상품이 ${input.partlessCount}개 있습니다`,
      detail: "부위를 채워야 상품이 정확히 관리됩니다. 목록에서 채워 넣으세요.",
      buttonLabel: "부위 채우러 가기",
      href: PRODUCTS_PARTLESS_FILTER_PATH,
      linkLabel: `부위가 비어 있는 상품 ${input.partlessCount}개 채우기`,
    },
    {
      key: "hot-deal-reached",
      count: input.hotDealReachedCount,
      title: `핫딜이 매진돼 자동으로 기본가로 바뀐 상품이 ${input.hotDealReachedCount}개 있습니다`,
      detail: "일반 매장에서는 계속 팔리고 있습니다. 핫딜을 완전히 끝내려면 상품 수정 화면에서 핫딜 토글을 직접 꺼주세요.",
      buttonLabel: "확인하러 가기",
      href: PRODUCTS_ANCHORS.hotDealReached,
      linkLabel: `핫딜 매진돼 자동 전환된 상품 ${input.hotDealReachedCount}개 확인하기`,
    },
    {
      key: "hot-deal-nearing",
      count: input.hotDealNearingCount,
      title: `핫딜 매진이 임박한 상품이 ${input.hotDealNearingCount}개 있습니다`,
      detail: "곧 매진되어 기본가로 자동 전환됩니다. 한도를 늘리고 싶으면 미리 조정하세요.",
      buttonLabel: "확인하러 가기",
      href: PRODUCTS_ANCHORS.hotDealNearing,
      linkLabel: `핫딜 매진 임박 상품 ${input.hotDealNearingCount}개 보기`,
    },
  ];
}

export function pickProductsNextStep(input: ProductsNextStepInput): ProductsNextStep | null {
  if (input.totalCount === 0) {
    return {
      key: "seed",
      title: "등록된 상품이 없습니다",
      detail: "소·돼지·닭·오리·계란은 입고 스캔을 하면 자동으로 등록됩니다. 양·가공육 등은 아래에서 기본 품목을 불러오거나 직접 등록하세요.",
      buttonLabel: "등록하러 가기",
      href: PRODUCTS_ANCHORS.seed,
      secondaries: [],
    };
  }

  const active = buildCandidates(input).filter((candidate) => candidate.count > 0);

  if (active.length === 0) {
    return null;
  }

  const [top, ...rest] = active;

  return {
    key: top.key,
    title: top.title,
    detail: top.detail,
    buttonLabel: top.buttonLabel,
    href: top.href,
    secondaries: rest.map((candidate) => ({ label: candidate.linkLabel, href: candidate.href })),
  };
}
