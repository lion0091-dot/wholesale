import { describe, expect, it } from "vitest";
import { originMatches } from "@/lib/products/origin-options";
import { findProductForSpec, productSpecLabel, specFromProduct, type ProductOption } from "./product-match";

const product = (patch: Partial<ProductOption>): ProductOption => ({
  id: "p",
  name: "상품",
  category: "소",
  subcategory: "등심",
  grade: "1++",
  origin: "국내산",
  ...patch,
});

describe("originMatches — 포함 비교", () => {
  it("한쪽이 다른 쪽을 포함하면 같다", () => {
    expect(originMatches("미국산", "미국")).toBe(true);
    expect(originMatches("미국", "미국산")).toBe(true);
    expect(originMatches("기타 수입산", "수입산")).toBe(true);
  });

  it("다른 나라·국내/수입은 다르고, 하나만 비면 다르다", () => {
    expect(originMatches("미국산", "호주산")).toBe(false);
    expect(originMatches("국내산", "기타 수입산")).toBe(false);
    expect(originMatches("국내산", "")).toBe(false);
    expect(originMatches(null, "")).toBe(true);
  });
});

describe("productSpecLabel", () => {
  it("소는 부위·등급·원산지, 돼지는 등급 없이, 닭·오리·계란은 원산지만", () => {
    expect(productSpecLabel(product({}))).toBe("소 등심 1++ 국내산");
    expect(productSpecLabel(product({ category: "돼지", subcategory: "삼겹살", grade: "특" }))).toBe("돼지 삼겹살 국내산");
    expect(productSpecLabel(product({ category: "닭", subcategory: "다리살", grade: null }))).toBe("닭 국내산");
  });

  it("키 없는 축종은 상품명을 넣는다", () => {
    expect(productSpecLabel(product({ category: "가공육", name: "수제 소불고기", subcategory: null, grade: null }))).toBe("가공육 수제 소불고기 국내산");
  });
});

describe("specFromProduct", () => {
  it("키 없는 축종은 부위가 비면 상품명을 부위 자리에 둔다", () => {
    expect(specFromProduct(product({ category: "가공육", name: "소시지", subcategory: null, grade: null }))).toEqual({
      category: "가공육",
      subcategory: "소시지",
      grade: "",
      origin: "국내산",
    });
    expect(specFromProduct(product({ category: "소", subcategory: null }))).toMatchObject({ subcategory: "" });
  });
});

describe("findProductForSpec", () => {
  const products = [
    product({ id: "beef" }),
    product({ id: "us-beef", origin: "미국산", subcategory: "안심", grade: "1" }),
    product({ id: "pork", category: "돼지", subcategory: "삼겹살", grade: null }),
    product({ id: "chicken", category: "닭", subcategory: null, grade: null }),
    product({ id: "sausage", category: "가공육", name: "소시지", subcategory: null, grade: null }),
  ];
  const spec = (patch: Record<string, string>) => ({ category: "소", subcategory: "등심", grade: "1++", origin: "국내산", ...patch });

  it("키 칸이 모두 같으면 찾고, 원산지는 포함 비교", () => {
    expect(findProductForSpec(spec({}), products)?.id).toBe("beef");
    expect(findProductForSpec(spec({ subcategory: "안심", grade: "1", origin: "미국" }), products)?.id).toBe("us-beef");
    expect(findProductForSpec(spec({ category: "돼지", subcategory: "삼겹살", grade: "아무거나" }), products)?.id).toBe("pork");
    expect(findProductForSpec(spec({ category: "닭", subcategory: "다리살", grade: "" }), products)?.id).toBe("chicken");
  });

  it("칸이 하나라도 다르거나 비어 있으면 붙이지 않는다", () => {
    expect(findProductForSpec(spec({ grade: "1+" }), products)).toBeNull();
    expect(findProductForSpec(spec({ grade: "" }), products)).toBeNull();
    expect(findProductForSpec(spec({ origin: "호주산" }), products)).toBeNull();
  });

  it("키 없는 축종은 스펙으로 못 찾는다", () => {
    expect(findProductForSpec(spec({ category: "가공육", subcategory: "소시지" }), products)).toBeNull();
  });
});
