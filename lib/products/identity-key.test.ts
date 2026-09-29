import { describe, expect, it } from "vitest";
import {
  bmsAppliesTo,
  composeIdentityName,
  formatGradeWithBms,
  identityFieldsFor,
  PART_UNSPECIFIED_LABEL,
} from "@/lib/products/identity-key";

describe("identityFieldsFor", () => {
  it("소는 품종·부위·등급·성별·원산지·냉장냉동이 키다", () => {
    expect(identityFieldsFor("소")).toEqual(["breed", "subcategory", "grade", "sex", "origin", "storageState"]);
  });

  it("돼지는 부위·원산지·냉장냉동, 닭·오리는 원산지·냉장냉동, 계란은 원산지만 키다", () => {
    expect(identityFieldsFor("돼지")).toEqual(["subcategory", "origin", "storageState"]);
    expect(identityFieldsFor("닭")).toEqual(["origin", "storageState"]);
    expect(identityFieldsFor("오리")).toEqual(["origin", "storageState"]);
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

describe("bmsAppliesTo", () => {
  it("소이면서 등급이 1++일 때만 true", () => {
    expect(bmsAppliesTo("소", "1++")).toBe(true);
    expect(bmsAppliesTo("소", "1+")).toBe(false);
    expect(bmsAppliesTo("소", null)).toBe(false);
    expect(bmsAppliesTo("돼지", "1++")).toBe(false);
  });
});

// identity-key.ts(상품명)·product-match.ts(발주서 목록 라벨)·message.ts(카톡 문구)·
// purchase-order-view.tsx(발주서 화면 미리보기) 네 곳이 이 조립을 각자 따로 구현했다가
// 한 곳만 고쳐서 표기가 갈리는 버그가 있었다(통단테 발견, 2026-09-30) — 공유 함수로
// 뺀 뒤 그 네 곳이 전부 이 함수를 부른다. 여기서 한 번만 검증하면 네 곳이 다 맞다.
describe("formatGradeWithBms", () => {
  it("소 1++는 등급 바로 뒤에 BMS를 괄호로 붙인다", () => {
    expect(formatGradeWithBms("소", "1++", "9")).toBe("1++(9)");
  });

  it("소라도 1++가 아니면 BMS를 무시하고 등급만 남긴다", () => {
    expect(formatGradeWithBms("소", "1+", "9")).toBe("1+");
  });

  it("소가 아니면 BMS를 무시한다(잘못 들어온 값이라도)", () => {
    expect(formatGradeWithBms("돼지", "1++", "9")).toBe("1++");
  });

  it("BMS 값이 없으면 등급만 그대로", () => {
    expect(formatGradeWithBms("소", "1++", null)).toBe("1++");
    expect(formatGradeWithBms("소", "1++", "")).toBe("1++");
  });

  it("등급이 없으면 빈 문자열(BMS 있어도 등급 없이는 안 보임)", () => {
    expect(formatGradeWithBms("소", null, "9")).toBe("");
  });

  it("BMS 값의 앞뒤 공백은 다듬는다(등급은 bmsAppliesTo 판정에 쓰이므로 호출부가 이미 다듬어 건넨다)", () => {
    expect(formatGradeWithBms("소", "1++", " 9 ")).toBe("1++(9)");
  });
});

describe("composeIdentityName", () => {
  it("소 상품명은 '냉장/냉동 품종 부위 등급 성별' — 축종은 화면 태그가 붙여주므로 넣지 않는다", () => {
    expect(
      composeIdentityName("소", { subcategory: "등심", grade: "1++", breed: "한우", sex: "거세", storageState: "냉장" })
    ).toBe("냉장 한우 등심 1++ 거세");
    expect(
      composeIdentityName("소", { subcategory: "등심", grade: "1++", breed: "육우", sex: "암", storageState: "냉동" })
    ).toBe("냉동 육우 등심 1++ 암");
  });

  it("1++ 등급에서 BMS가 있으면 등급 바로 뒤에 괄호로 붙인다", () => {
    expect(
      composeIdentityName("소", {
        subcategory: "등심",
        grade: "1++",
        breed: "한우",
        sex: "거세",
        storageState: "냉장",
        bms: "9",
      })
    ).toBe("냉장 한우 등심 1++(9) 거세");
  });

  it("1++가 아니면 BMS 값이 있어도 무시한다", () => {
    expect(
      composeIdentityName("소", { subcategory: "등심", grade: "1+", breed: "한우", sex: "거세", bms: "9" })
    ).toBe("한우 등심 1+ 거세");
  });

  it("품종·성별·냉장냉동이 비어 있는 소(도입 전 상품)는 그 칸 없이 '부위 등급'", () => {
    expect(composeIdentityName("소", { subcategory: "등심", grade: "1++" })).toBe("등심 1++");
  });

  it("품종·성별은 소에서만 이름에 들어간다", () => {
    expect(composeIdentityName("돼지", { subcategory: "삼겹살", grade: null, breed: "한우", sex: "거세" })).toBe(
      "삼겹살"
    );
  });

  it("앞뒤 공백은 정리한다", () => {
    expect(composeIdentityName("소", { subcategory: "  등심 ", grade: " 1+ " })).toBe("등심 1+");
  });

  it("부위가 없으면 끝에 '(부위 미지정)'을 붙인다", () => {
    expect(composeIdentityName("소", { subcategory: null, grade: "1++" })).toBe(`1++ ${PART_UNSPECIFIED_LABEL}`);
    expect(composeIdentityName("소", { subcategory: "", grade: "" })).toBe(PART_UNSPECIFIED_LABEL);
  });

  it("등급이 없으면 부위만 쓴다", () => {
    expect(composeIdentityName("소", { subcategory: "안심", grade: null })).toBe("안심");
  });

  it("돼지는 부위(+냉장냉동)만 쓰고 등급은 이름에 넣지 않는다", () => {
    expect(composeIdentityName("돼지", { subcategory: "삼겹살", grade: "1등급" })).toBe("삼겹살");
    expect(composeIdentityName("돼지", { subcategory: "삼겹살", grade: null, storageState: "냉동" })).toBe(
      "냉동 삼겹살"
    );
    expect(composeIdentityName("돼지", { subcategory: null, grade: null })).toBe(PART_UNSPECIFIED_LABEL);
  });

  it("닭·오리는 축종 이름(+냉장냉동), 계란은 축종 이름 그대로", () => {
    expect(composeIdentityName("닭", { subcategory: "다리살", grade: "특" })).toBe("닭");
    expect(composeIdentityName("닭", { storageState: "냉동" })).toBe("냉동 닭");
    expect(composeIdentityName("오리", {})).toBe("오리");
    expect(composeIdentityName("계란", {})).toBe("계란");
  });

  it("키 규칙이 없는 축종은 null — 사용자가 적은 이름을 쓴다", () => {
    expect(composeIdentityName("양", { subcategory: "양갈비", grade: null })).toBeNull();
  });
});
