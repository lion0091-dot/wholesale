import { describe, expect, it } from "vitest";
import { isTraceableCategory, TRACEABLE_CATEGORIES } from "./traceable-categories";
import { DEFAULT_DELIVERY_ITEMS, MANUAL_DEFAULT_DELIVERY_ITEMS } from "./default-delivery-items";

describe("이력 대상 축종 — 손 등록 차단", () => {
  it("소·돼지·닭/오리만 이력 대상이고 양·가공육·빈 값은 아니다", () => {
    expect(TRACEABLE_CATEGORIES).toEqual(["소", "돼지", "닭/오리"]);
    expect(["소", "돼지", "닭/오리"].every(isTraceableCategory)).toBe(true);
    expect(["양", "가공육", "", null, undefined].some((value) => isTraceableCategory(value))).toBe(false);
  });

  it("기본 납품 품목 시드는 이력 대상 축종을 뺀 것만 남는다", () => {
    expect(MANUAL_DEFAULT_DELIVERY_ITEMS.length).toBeGreaterThan(0);
    expect(MANUAL_DEFAULT_DELIVERY_ITEMS.length).toBeLessThan(DEFAULT_DELIVERY_ITEMS.length);
    expect(MANUAL_DEFAULT_DELIVERY_ITEMS.some((item) => isTraceableCategory(item.category))).toBe(false);
  });
});
