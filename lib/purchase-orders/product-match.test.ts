import { describe, expect, it } from "vitest";
import { originMatches } from "@/lib/products/origin-options";
import { findProductForSpec, productSpecLabel, specFromProduct, type ProductOption } from "./product-match";

const product = (patch: Partial<ProductOption>): ProductOption => ({
  id: "p",
  name: "상품",
  category: "소",
  subcategory: "등심",
  grade: "1++",
  breed: "한우",
  sex: null,
  bms: null,
  storageState: null,
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
  it("소는 품종·부위·등급·원산지, 돼지는 등급 없이, 닭·오리·계란은 원산지만", () => {
    expect(productSpecLabel(product({}))).toBe("소 한우 등심 1++ 국내산");
    expect(productSpecLabel(product({ breed: "육우" }))).toBe("소 육우 등심 1++ 국내산");
    expect(productSpecLabel(product({ category: "돼지", breed: null, subcategory: "삼겹살", grade: "특" }))).toBe("돼지 삼겹살 국내산");
    expect(productSpecLabel(product({ category: "닭", breed: null, subcategory: "다리살", grade: null }))).toBe("닭 국내산");
  });

  it("키 없는 축종은 상품명을 넣는다", () => {
    expect(productSpecLabel(product({ category: "가공육", name: "수제 소불고기", subcategory: null, grade: null }))).toBe("가공육 수제 소불고기 국내산");
  });

  it("성별·냉장냉동·(1++ 소만) BMS를 라벨에 넣는다", () => {
    expect(productSpecLabel(product({ sex: "거세", storageState: "냉장" }))).toBe("냉장 소 한우 등심 1++ 거세 국내산");
    // BMS는 등급 바로 뒤에 괄호로 붙는다("1++(9)").
    expect(productSpecLabel(product({ sex: "거세", bms: "9" }))).toBe("소 한우 등심 1++(9) 거세 국내산");
    // 1++가 아니면 BMS가 있어도 라벨에 안 나온다(등급이 다르면 BMS 개념 자체가 없다).
    expect(productSpecLabel(product({ grade: "1", sex: "암", bms: "9" }))).toBe("소 한우 등심 1 암 국내산");
    expect(productSpecLabel(product({ category: "돼지", breed: null, subcategory: "삼겹살", grade: "특", storageState: "냉동" }))).toBe("냉동 돼지 삼겹살 국내산");
  });
});

describe("specFromProduct", () => {
  it("키 없는 축종은 부위가 비면 상품명을 부위 자리에 둔다", () => {
    expect(specFromProduct(product({ category: "가공육", name: "소시지", breed: null, subcategory: null, grade: null }))).toEqual({
      category: "가공육",
      breed: "",
      subcategory: "소시지",
      grade: "",
      sex: "",
      bms: "",
      storageState: "",
      origin: "국내산",
    });
    expect(specFromProduct(product({ category: "소", subcategory: null }))).toMatchObject({ subcategory: "" });
  });

  it("성별·냉장냉동을 그대로 옮기고, BMS는 1++일 때만 옮긴다", () => {
    expect(specFromProduct(product({ sex: "거세", storageState: "냉장", bms: "9" }))).toMatchObject({ sex: "거세", storageState: "냉장", bms: "9" });
    expect(specFromProduct(product({ grade: "1", sex: "암", bms: "9" }))).toMatchObject({ bms: "" });
  });
});

describe("findProductForSpec", () => {
  const products = [
    product({ id: "beef" }),
    product({ id: "us-beef", origin: "미국산", subcategory: "안심", grade: "1" }),
    product({ id: "yuk-beef", breed: "육우" }),
    product({ id: "pork", category: "돼지", breed: null, subcategory: "삼겹살", grade: null }),
    product({ id: "chicken", category: "닭", breed: null, subcategory: null, grade: null }),
    product({ id: "sausage", category: "가공육", name: "소시지", breed: null, subcategory: null, grade: null }),
    product({ id: "beef-female", sex: "암" }),
    product({ id: "beef-frozen", storageState: "냉동" }),
    product({ id: "beef-bms9", bms: "9" }),
    product({ id: "beef-bms8", bms: "8" }),
  ];
  const spec = (patch: Record<string, string>) => ({
    category: "소",
    breed: "한우",
    subcategory: "등심",
    grade: "1++",
    sex: "",
    bms: "",
    storageState: "",
    origin: "국내산",
    ...patch,
  });

  it("키 칸이 모두 같으면 찾고, 원산지는 포함 비교", () => {
    expect(findProductForSpec(spec({}), products)?.id).toBe("beef");
    expect(findProductForSpec(spec({ subcategory: "안심", grade: "1", origin: "미국" }), products)?.id).toBe("us-beef");
    expect(findProductForSpec(spec({ category: "돼지", subcategory: "삼겹살", grade: "아무거나" }), products)?.id).toBe("pork");
    expect(findProductForSpec(spec({ category: "닭", subcategory: "다리살", grade: "" }), products)?.id).toBe("chicken");
  });

  it("한우와 육우는 같은 부위·등급·원산지라도 다른 상품", () => {
    expect(findProductForSpec(spec({ breed: "한우" }), products)?.id).toBe("beef");
    expect(findProductForSpec(spec({ breed: "육우" }), products)?.id).toBe("yuk-beef");
    expect(findProductForSpec(spec({ breed: "젖소" }), products)).toBeNull();
    expect(findProductForSpec(spec({ breed: "" }), products)).toBeNull();
  });

  it("칸이 하나라도 다르거나 비어 있으면 붙이지 않는다", () => {
    expect(findProductForSpec(spec({ grade: "1+" }), products)).toBeNull();
    expect(findProductForSpec(spec({ grade: "" }), products)).toBeNull();
    expect(findProductForSpec(spec({ origin: "호주산" }), products)).toBeNull();
  });

  it("키 없는 축종은 스펙으로 못 찾는다", () => {
    expect(findProductForSpec(spec({ category: "가공육", subcategory: "소시지" }), products)).toBeNull();
  });

  it("성별·냉장냉동이 다르면 다른 상품, BMS는 1++일 때만 구분한다", () => {
    expect(findProductForSpec(spec({}), products)?.id).toBe("beef");
    expect(findProductForSpec(spec({ sex: "암" }), products)?.id).toBe("beef-female");
    expect(findProductForSpec(spec({ storageState: "냉동" }), products)?.id).toBe("beef-frozen");
    expect(findProductForSpec(spec({ bms: "9" }), products)?.id).toBe("beef-bms9");
    expect(findProductForSpec(spec({ bms: "8" }), products)?.id).toBe("beef-bms8");
    // 1++가 아니면 BMS는 정체성이 아니라 무시한다 — bms 값이 있어도 그 등급의 상품과 맞는다.
    expect(findProductForSpec(spec({ grade: "1", subcategory: "안심", origin: "미국산", bms: "9" }), products)?.id).toBe("us-beef");
  });
});
