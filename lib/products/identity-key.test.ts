import { describe, expect, it } from "vitest";
import { composeIdentityName, identityFieldsFor, PART_UNSPECIFIED_LABEL } from "@/lib/products/identity-key";

describe("identityFieldsFor", () => {
  it("소는 부위·등급·원산지가 키다", () => {
    expect(identityFieldsFor("소")).toEqual(["subcategory", "grade", "origin"]);
  });

  it("규칙이 정해지지 않은 축종·빈 값은 null(예전 동작 그대로)", () => {
    expect(identityFieldsFor("돼지")).toBeNull();
    expect(identityFieldsFor("닭")).toBeNull();
    expect(identityFieldsFor("")).toBeNull();
    expect(identityFieldsFor(null)).toBeNull();
    expect(identityFieldsFor(undefined)).toBeNull();
  });
});

describe("composeIdentityName", () => {
  it("소 상품명은 '부위 등급' — 축종은 화면 태그가 붙여주므로 넣지 않는다", () => {
    expect(composeIdentityName("소", "등심", "1++")).toBe("등심 1++");
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

  it("키 규칙이 없는 축종은 null — 사용자가 적은 이름을 쓴다", () => {
    expect(composeIdentityName("돼지", "삼겹살", "1등급")).toBeNull();
  });
});
