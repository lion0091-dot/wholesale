import { describe, expect, it } from "vitest";
import { summarizeOrderMargin, type OrderMarginRow } from "./order-margin";

const row = (over: Partial<OrderMarginRow>): OrderMarginRow => ({
  productId: "p1",
  productName: "등심",
  unit: "kg",
  soldQty: 4,
  salesAmount: 272000,
  shippedQty: 4,
  costAmount: 200000,
  unpricedQty: 0,
  ...over,
});

describe("summarizeOrderMargin", () => {
  it("상품별·합계 마진과 마진율을 계산한다", () => {
    const summary = summarizeOrderMargin([
      row({}),
      row({ productId: "p2", productName: "삼겹살", salesAmount: 100000, costAmount: 70000, shippedQty: 5 }),
    ]);

    expect(summary.lines[0]).toMatchObject({ marginAmount: 72000, marginRate: 26.5, incomplete: false });
    expect(summary.lines[1]).toMatchObject({ marginAmount: 30000, marginRate: 30 });
    expect(summary.salesAmount).toBe(372000);
    expect(summary.costAmount).toBe(270000);
    expect(summary.marginAmount).toBe(102000);
    expect(summary.marginRate).toBe(27.4);
    expect(summary.incomplete).toBe(false);
  });

  it("원가를 모르는 양이 있으면 0원으로 치지 않고 미완성으로 표시한다", () => {
    const summary = summarizeOrderMargin([row({ costAmount: 80000, unpricedQty: 2 }), row({ productId: "p2", unpricedQty: 0 })]);

    expect(summary.lines[0].incomplete).toBe(true);
    expect(summary.lines[1].incomplete).toBe(false);
    expect(summary.incomplete).toBe(true);
    expect(summary.unpricedQty).toBe(2);
  });

  it("판매금액이 0이면 마진율은 null이다", () => {
    const summary = summarizeOrderMargin([row({ salesAmount: 0, costAmount: 0, shippedQty: 1 })]);

    expect(summary.marginRate).toBeNull();
    expect(summary.lines[0].marginRate).toBeNull();
  });

  it("원가보다 싸게 팔았으면 마진이 음수다", () => {
    const summary = summarizeOrderMargin([row({ salesAmount: 100000, costAmount: 120000 })]);

    expect(summary.marginAmount).toBe(-20000);
    expect(summary.marginRate).toBe(-20);
  });

  it("나간 게 하나도 없으면 hasShipment가 false다(패널 숨김 기준)", () => {
    expect(summarizeOrderMargin([row({ shippedQty: 0, costAmount: 0 })]).hasShipment).toBe(false);
    expect(summarizeOrderMargin([]).hasShipment).toBe(false);
  });
});
