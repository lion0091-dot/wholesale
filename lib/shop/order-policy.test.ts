import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_ORDER_AMOUNT,
  cartTotals,
  lineSubtotal,
  minQuantityFor,
  normalizeQuantity,
  quantityStepFor,
  validateCart,
  type CartLine,
} from "@/lib/shop/order-policy";

function makeLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    productId: "p1",
    name: "한우 등심",
    category: "소",
    subcategory: "등심",
    unit: "kg",
    unitPrice: 30000,
    basePrice: 30000,
    quantity: 2,
    stockQuantity: 10,
    isCustomPrice: false,
    isHotDeal: false,
    ...overrides,
  };
}

describe("quantityStepFor / minQuantityFor", () => {
  it("kg/근은 0.5 단위", () => {
    expect(quantityStepFor("kg")).toBe(0.5);
    expect(quantityStepFor("근")).toBe(0.5);
    expect(minQuantityFor("KG")).toBe(0.5);
  });

  it("그 외 단위는 1 단위", () => {
    expect(quantityStepFor("박스")).toBe(1);
    expect(quantityStepFor("마리")).toBe(1);
  });
});

describe("normalizeQuantity", () => {
  it("재고 초과분은 재고로 캡핑한다", () => {
    expect(normalizeQuantity(100, "kg", 10)).toBe(10);
  });

  it("단위 스텝에 맞춰 반올림한다", () => {
    expect(normalizeQuantity(1.3, "kg", 10)).toBe(1.5);
    expect(normalizeQuantity(2, "박스", 10)).toBe(2);
  });

  it("0 이하 입력이나 재고 0이면 0을 돌려준다", () => {
    expect(normalizeQuantity(0, "kg", 10)).toBe(0);
    expect(normalizeQuantity(-1, "kg", 10)).toBe(0);
    expect(normalizeQuantity(5, "kg", 0)).toBe(0);
    expect(normalizeQuantity(NaN, "kg", 10)).toBe(0);
  });
});

describe("lineSubtotal / cartTotals", () => {
  it("소계는 단가 × 수량을 반올림한다", () => {
    expect(lineSubtotal(makeLine({ unitPrice: 3333, quantity: 3 }))).toBe(9999);
  });

  it("여러 줄의 합계·절감액을 누적한다", () => {
    const lines = [
      makeLine({ unitPrice: 30000, basePrice: 30000, quantity: 2 }),
      makeLine({ productId: "p2", unitPrice: 8000, basePrice: 10000, quantity: 1, isCustomPrice: true }),
    ];

    const totals = cartTotals(lines);

    expect(totals.itemCount).toBe(2);
    expect(totals.totalQuantity).toBe(3);
    expect(totals.totalAmount).toBe(68000);
    expect(totals.savedAmount).toBe(2000);
  });
});

describe("validateCart", () => {
  it("빈 장바구니는 empty 위반", () => {
    const result = validateCart([]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("empty");
  });

  it("최소 주문 금액 미달이면 min_order_amount 위반과 부족분을 돌려준다", () => {
    const lines = [makeLine({ unitPrice: 10000, quantity: 1 })];
    const result = validateCart(lines, 50000);

    expect(result.ok).toBe(false);
    expect(result.shortfallAmount).toBe(40000);
    expect(result.violations.map((v) => v.code)).toContain("min_order_amount");
  });

  it("공급사별 최소 금액을 안 넘기면 기본값(DEFAULT_MIN_ORDER_AMOUNT)을 쓴다", () => {
    const lines = [makeLine({ unitPrice: 10000, quantity: 1 })];
    const result = validateCart(lines);

    expect(result.shortfallAmount).toBe(DEFAULT_MIN_ORDER_AMOUNT - 10000);
  });

  it("품절 상품은 out_of_stock 위반", () => {
    const lines = [makeLine({ stockQuantity: 0, quantity: 1 })];
    const result = validateCart(lines, 0);

    expect(result.violations.some((v) => v.code === "out_of_stock")).toBe(true);
  });

  it("재고 초과 수량도 out_of_stock 위반", () => {
    const lines = [makeLine({ stockQuantity: 5, quantity: 10 })];
    const result = validateCart(lines, 0);

    expect(result.violations.some((v) => v.code === "out_of_stock")).toBe(true);
  });

  it("최소 수량 미만이면 min_quantity 위반", () => {
    const lines = [makeLine({ unit: "박스", quantity: 0.5, stockQuantity: 10 })];
    const result = validateCart(lines, 0);

    expect(result.violations.some((v) => v.code === "min_quantity")).toBe(true);
  });

  it("모든 조건을 만족하면 ok=true", () => {
    const lines = [makeLine({ unitPrice: 60000, quantity: 1, stockQuantity: 10 })];
    const result = validateCart(lines, 50000);

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
