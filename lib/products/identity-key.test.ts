import { describe, expect, it } from "vitest";
import { composeIdentityName, identityFieldsFor, PART_UNSPECIFIED_LABEL } from "@/lib/products/identity-key";

describe("identityFieldsFor", () => {
  it("소는 품종·부위·등급·원산지가 키다", () => {
    expect(identityFieldsFor("소")).toEqual(["breed", "subcategory", "grade", "origin"]);
  });

  it("돼지는 부위·원산지, 닭·오리·계란은 원산지만 키다", () => {
    expect(identityFieldsFor("돼지")).toEqual(["subcategory", "origin"]);
    expect(identityFieldsFor("닭")).toEqual(["origin"]);
    expect(identityFieldsFor("오리")).toEqual(["origin"]);
    expect(identityFieldsFor("계란")).toEqual(["origin"]);
  });

  it("규칙이 정해지지 않은 축종·빈 값은 null(예전 동작 그대로)", () => {
    expect(identityFieldsFor("양")).toBeNull();
    expect(identityFieldsFor("가공육")).toBeNull();
    expect(identityFieldsFor("")).toBeNull();
    expect(identityFieldsFor(null)).toBeNull();
    expect(identityFieldsFor(undefined)).toBeNull();
  });
});

describe("composeIdentityName", () => {
  it("소 상품명은 '품종 부위 등급' — 축종은 화면 태그가 붙여주므로 넣지 않는다", () => {
    expect(composeIdentityName("소", "등심", "1++", "한우")).toBe("한우 등심 1++");
    expect(composeIdentityName("소", "등심", "1++", "육우")).toBe("육우 등심 1++");
  });

  it("품종이 비어 있는 소(품종 도입 전 상품)는 품종 없이 '부위 등급'", () => {
    expect(composeIdentityName("소", "등심", "1++")).toBe("등심 1++");
  });

  it("품종은 소에서만 이름에 들어간다", () => {
    expect(composeIdentityName("돼지", "삼겹살", null, "한우")).toBe("삼겹살");
  });

  it("앞뒤 공백은 정리한다", () => {
    expect(composeIdentityName("소", "  등심 ", " 1+ ")).toBe("등심 1+");
  });

  it("부위가 없으면 끝에 '(부위 미지정)'을 붙인다", () => {
    expect(composeIdentityName("소", null, "1++")).toBe(`1++ ${PART_UNSPECIFIED_LABEL}`);
    expect(composeIdentityName("소", "", "")).toBe(PART_UNSPECIFIED_LABEL);
  });

  it("등급이 없으면 부위만 쓴다", () => {
    expect(composeIdentityName("소", "안심", null)).toBe("안심");
  });

  it("돼지는 부위만 쓰고 등급은 이름에 넣지 않는다", () => {
    expect(composeIdentityName("돼지", "삼겹살", "1등급")).toBe("삼겹살");
    expect(composeIdentityName("돼지", null, null)).toBe(PART_UNSPECIFIED_LABEL);
  });

  it("닭·오리·계란은 축종 이름 그대로", () => {
    expect(composeIdentityName("닭", "다리살", "특")).toBe("닭");
    expect(composeIdentityName("오리", null, null)).toBe("오리");
    expect(composeIdentityName("계란", null, null)).toBe("계란");
  });

  it("키 규칙이 없는 축종은 null — 사용자가 적은 이름을 쓴다", () => {
    expect(composeIdentityName("양", "양갈비", null)).toBeNull();
  });
});
