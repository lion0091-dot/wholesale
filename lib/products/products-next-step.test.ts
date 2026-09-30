import { describe, expect, it } from "vitest";
import { pickProductsNextStep, PRODUCTS_ANCHORS, PRODUCTS_PARTLESS_FILTER_PATH } from "./products-next-step";

const base = {
  totalCount: 10,
  autoStoppedCount: 0,
  unpricedCount: 0,
  partlessCount: 0,
  hotDealReachedCount: 0,
  hotDealNearingCount: 0,
};

describe("pickProductsNextStep", () => {
  it("상품이 하나도 없으면 등록 안내가 나온다", () => {
    const step = pickProductsNextStep({ ...base, totalCount: 0 });

    expect(step?.key).toBe("seed");
  });

  it("아무 문제도 없으면 카드를 숨긴다(null)", () => {
    expect(pickProductsNextStep(base)).toBeNull();
  });

  it("여러 문제가 동시에 있어도 카드는 가장 급한 것 하나만 강조한다 — 주문막힘이 1순위", () => {
    const step = pickProductsNextStep({
      ...base,
      autoStoppedCount: 2,
      unpricedCount: 3,
      partlessCount: 1,
      hotDealReachedCount: 1,
      hotDealNearingCount: 1,
    });

    expect(step?.key).toBe("auto-stopped");
    expect(step?.href).toBe(PRODUCTS_ANCHORS.autoStopped);
    // 나머지 4개는 작은 링크로 밀린다 — 사라지지 않는다.
    expect(step?.secondaries).toHaveLength(4);
  });

  it("주문막힘이 없으면 판매가 미설정이 1순위로 올라온다", () => {
    const step = pickProductsNextStep({ ...base, unpricedCount: 5, partlessCount: 2 });

    expect(step?.key).toBe("unpriced");
    expect(step?.secondaries.map((s) => s.label)).toEqual([
      "부위가 비어 있는 상품 2개 채우기",
    ]);
  });

  it("부위 미지정만 있으면 상품 목록 보관함 필터와 같은 방식으로 딥링크한다", () => {
    const step = pickProductsNextStep({ ...base, partlessCount: 4 });

    expect(step?.key).toBe("partless");
    expect(step?.href).toBe(PRODUCTS_PARTLESS_FILTER_PATH);
  });

  it("핫딜 매진 임박만 있으면 그게 1순위다(가장 낮은 우선순위여도 유일하면 강조)", () => {
    const step = pickProductsNextStep({ ...base, hotDealNearingCount: 1 });

    expect(step?.key).toBe("hot-deal-nearing");
    expect(step?.secondaries).toHaveLength(0);
  });
});
