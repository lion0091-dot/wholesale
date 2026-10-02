import { describe, expect, it } from "vitest";
import { summarizeValuation, type ValuationRow } from "./inventory-valuation";

const row = (over: Partial<ValuationRow>): ValuationRow => ({
  productId: "p1",
  productName: "등심",
  unit: "kg",
  boxCount: 3,
  remainingQty: 18,
  valuedQty: 15,
  valueAmount: 650000,
  unpricedQty: 0,
  boxlessQty: 0,
  oldestAt: "2026-08-23T00:00:00Z",
  oldestDays: 40,
  ...over,
});

describe("summarizeValuation", () => {
  it("총 평가금액과 가장 오래된 재고를 계산한다", () => {
    const summary = summarizeValuation([row({}), row({ productId: "p2", valueAmount: 100000, valuedQty: 5, oldestDays: 3 })]);

    expect(summary.totalValue).toBe(750000);
    expect(summary.oldestDays).toBe(40);
    expect(summary.incomplete).toBe(false);
    expect(summary.lines[0].averageUnitCost).toBe(43333);
    expect(summary.lines[1].averageUnitCost).toBe(20000);
  });

  it("오래됨 판정은 하지 않고 가장 오래된 박스의 경과일만 알려준다", () => {
    const summary = summarizeValuation([row({ oldestDays: 3 }), row({ productId: "p2", oldestDays: 90 }), row({ productId: "p3", oldestDays: null })]);

    expect(summary.oldestDays).toBe(90);
    expect("aged" in summary.lines[0]).toBe(false);
  });

  it("단가 없는 박스와 박스 없는 재고는 0원으로 치지 않고 미완성으로 표시한다", () => {
    const summary = summarizeValuation([row({ unpricedQty: 3 }), row({ productId: "p2", boxlessQty: 2 }), row({ productId: "p3" })]);

    expect(summary.lines.map((line) => line.incomplete)).toEqual([true, true, false]);
    expect(summary.unknownQty).toBe(5);
    expect(summary.incomplete).toBe(true);
  });

  it("단가를 아는 재고가 없으면 평균 단가는 null이다", () => {
    const summary = summarizeValuation([row({ valuedQty: 0, valueAmount: 0, unpricedQty: 18 })]);

    expect(summary.lines[0].averageUnitCost).toBeNull();
    expect(summary.totalValue).toBe(0);
  });

  it("재고가 하나도 없으면 비어 있다", () => {
    const summary = summarizeValuation([]);

    expect(summary).toMatchObject({ totalValue: 0, oldestDays: null, incomplete: false });
  });
});
