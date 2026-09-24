import { describe, expect, it } from "vitest";
import { findCatalogItem, resolveCatalogItem, toCartLines, type ShopCatalog } from "@/lib/shop/catalog-types";
import { makeProduct, makeWholesaler } from "@/tests/fixtures";

describe("resolveCatalogItem", () => {
  it("핫딜이 꺼져 있으면 기준 단가를 쓴다", () => {
    const item = resolveCatalogItem(makeProduct({ base_price: 10000 }), undefined);

    expect(item.effectivePrice).toBe(10000);
    expect(item.isHotDeal).toBe(false);
  });

  it("핫딜이 켜져 있으면 할인가 + 전체 재고가 상한", () => {
    const product = makeProduct({
      base_price: 10000,
      hot_deal_active: true,
      hot_deal_price: 7000,
      stock_quantity: 20,
    });

    const item = resolveCatalogItem(product, undefined);

    expect(item.effectivePrice).toBe(7000);
    expect(item.isHotDeal).toBe(true);
    expect(item.orderableQuantity).toBe(20);
  });

  it("핫딜 한도 도달 시 자동으로 기준가 + 정상 판매로 되돌아간다", () => {
    const product = makeProduct({
      base_price: 10000,
      hot_deal_active: true,
      hot_deal_price: 7000,
      hot_deal_quantity_limit: 10,
      hot_deal_quantity_sold: 10,
      stock_quantity: 20,
    });

    const item = resolveCatalogItem(product, undefined);

    expect(item.isHotDeal).toBe(false);
    expect(item.effectivePrice).toBe(10000);
  });

  it("핫딜 한도가 재고보다 먼저 닿으면 남은 한도가 상한이 된다", () => {
    const product = makeProduct({
      hot_deal_active: true,
      hot_deal_price: 7000,
      hot_deal_quantity_limit: 5,
      hot_deal_quantity_sold: 3,
      stock_quantity: 100,
    });

    const item = resolveCatalogItem(product, undefined);

    expect(item.orderableQuantity).toBe(2);
  });

  it("맞춤단가는 핫딜이 아닐 때만 적용된다", () => {
    const item = resolveCatalogItem(makeProduct({ base_price: 10000 }), 8000);

    expect(item.effectivePrice).toBe(8000);
    expect(item.isCustomPrice).toBe(true);
  });
});

function makeCatalog(overrides: Partial<ShopCatalog> = {}): ShopCatalog {
  return {
    shopToken: "test-shop-token",
    wholesaler: makeWholesaler(),
    items: [],
    customer: {
      retailerId: null,
      restaurantName: null,
      representativeName: null,
      contactPhone: null,
      deliveryAddress: null,
      isLinked: false,
      creditLimit: 0,
      allowedPaymentMethods: [],
    },
    ...overrides,
  };
}

describe("toCartLines", () => {
  it("발주정지된 상품은 조용히 제외한다", () => {
    const product = makeProduct({ id: "p1", order_stopped: true, stock_quantity: 10 });
    const catalog = makeCatalog({ items: [resolveCatalogItem(product, undefined)] });

    const lines = toCartLines(catalog, [{ productId: "p1", quantity: 2 }]);

    expect(lines).toHaveLength(0);
  });

  it("존재하지 않는 상품 id는 무시한다", () => {
    const catalog = makeCatalog({ items: [] });
    const lines = toCartLines(catalog, [{ productId: "missing", quantity: 1 }]);

    expect(lines).toHaveLength(0);
  });

  it("정상 상품은 카탈로그 기준 단가로 환산된다", () => {
    const product = makeProduct({ id: "p1", base_price: 10000, stock_quantity: 10 });
    const item = resolveCatalogItem(product, undefined);
    const catalog = makeCatalog({ items: [item] });

    const lines = toCartLines(catalog, [{ productId: "p1", quantity: 2 }]);

    expect(lines).toHaveLength(1);
    expect(lines[0].unitPrice).toBe(10000);
    expect(lines[0].quantity).toBe(2);
  });

  it("네고가 꺼진 공급사는 희망단가를 무시한다", () => {
    const product = makeProduct({ id: "p1", stock_quantity: 10 });
    const item = resolveCatalogItem(product, undefined);
    const catalog = makeCatalog({
      items: [item],
      wholesaler: makeWholesaler({ allow_price_negotiation: false }),
    });

    const lines = toCartLines(catalog, [{ productId: "p1", quantity: 1, requestedUnitPrice: 9999 }]);

    expect(lines[0].requestedUnitPrice).toBeNull();
  });

  it("네고가 켜진 공급사는 유효한 희망단가를 반영한다", () => {
    const product = makeProduct({ id: "p1", stock_quantity: 10 });
    const item = resolveCatalogItem(product, undefined);
    const catalog = makeCatalog({
      items: [item],
      wholesaler: makeWholesaler({ allow_price_negotiation: true }),
    });

    const lines = toCartLines(catalog, [{ productId: "p1", quantity: 1, requestedUnitPrice: 9999 }]);

    expect(lines[0].requestedUnitPrice).toBe(9999);
  });
});

describe("findCatalogItem", () => {
  it("id로 항목을 찾는다", () => {
    const product = makeProduct({ id: "p1" });
    const item = resolveCatalogItem(product, undefined);
    const catalog = makeCatalog({ items: [item] });

    expect(findCatalogItem(catalog, "p1")).toBe(item);
    expect(findCatalogItem(catalog, "nope")).toBeUndefined();
  });
});
