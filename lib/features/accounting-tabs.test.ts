import { describe, expect, it } from "vitest";
import { buildAccountingTabs } from "./my-features";

const ALL = new Set([
  "accounting",
  "accounting_receivables",
  "accounting_purchases",
  "accounting_stock_adjust",
  "accounting_pnl",
  "accounting_integrity",
  "cost_management",
]);

const hrefs = (enabled: Set<string>, usable: Set<string>, isOwner: boolean) =>
  buildAccountingTabs(enabled, usable, isOwner).map((tab) => tab.href);

describe("buildAccountingTabs", () => {
  it("대표에게는 여섯 탭이 정해진 순서로 전부 보인다", () => {
    expect(hrefs(ALL, ALL, true)).toEqual([
      "/dashboard/receivables",
      "/dashboard/purchases",
      "/dashboard/stock-valuation",
      "/dashboard/stock-adjustments",
      "/dashboard/stock-pnl",
      "/dashboard/stock-integrity",
    ]);
  });

  it("손익 관리는 대표가 아니면 안 보이고, 탭 키를 끄면 빠진다", () => {
    expect(hrefs(ALL, ALL, false)).not.toContain("/dashboard/stock-pnl");

    const enabled = new Set(ALL);

    enabled.delete("accounting_pnl");

    expect(hrefs(enabled, ALL, true)).not.toContain("/dashboard/stock-pnl");
  });

  it("재고 조정·손실은 대표가 아니면 안 보이고, 탭 키를 끄면 빠진다", () => {
    expect(hrefs(ALL, ALL, false)).not.toContain("/dashboard/stock-adjustments");

    const enabled = new Set(ALL);

    enabled.delete("accounting_stock_adjust");

    expect(hrefs(enabled, ALL, true)).not.toContain("/dashboard/stock-adjustments");
  });

  it("장부 불일치는 대표가 아니면 안 보인다", () => {
    expect(hrefs(ALL, ALL, false)).not.toContain("/dashboard/stock-integrity");
  });

  it("원가 관리는 허용된 사람(usable)에게만 보인다", () => {
    expect(hrefs(ALL, new Set(), true)).not.toContain("/dashboard/stock-valuation");
  });

  it("탭 키를 끄면 그 탭만 빠진다", () => {
    const enabled = new Set(ALL);

    enabled.delete("accounting_purchases");

    expect(hrefs(enabled, ALL, true)).toEqual([
      "/dashboard/receivables",
      "/dashboard/stock-valuation",
      "/dashboard/stock-adjustments",
      "/dashboard/stock-pnl",
      "/dashboard/stock-integrity",
    ]);
  });

  it("켜진 기능이 하나도 없으면 빈 목록이라 메뉴가 숨겨진다(메뉴를 끄면 DB가 자식도 목록에서 뺀다)", () => {
    expect(hrefs(new Set(), new Set(), true)).toEqual([]);
  });

  it("메뉴 이동 주소는 보이는 첫 탭이다", () => {
    const enabled = new Set(["accounting_purchases", "accounting_integrity"]);

    expect(buildAccountingTabs(enabled, new Set(), true)[0]?.href).toBe("/dashboard/purchases");
  });
});
