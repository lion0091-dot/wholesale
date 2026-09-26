import { describe, expect, it } from "vitest";
import { partNameFromItemName } from "./part-name-from-item";

describe("partNameFromItemName", () => {
  it("품목명에 부위가 하나 있으면 그 부위를 돌려준다", () => {
    expect(partNameFromItemName("한우 등심")).toBe("등심");
    expect(partNameFromItemName("국내산 삼겹살")).toBe("삼겹살");
    expect(partNameFromItemName("돈육 목살 (냉장)")).toBe("목살");
  });

  it("긴 이름이 우선한다 — 꽃등심은 등심이 아니고, 앞다리살은 앞다리가 아니다", () => {
    expect(partNameFromItemName("한우 꽃등심")).toBe("꽃등심");
    expect(partNameFromItemName("돼지 앞다리살")).toBe("앞다리살");
    expect(partNameFromItemName("한우 아롱사태")).toBe("아롱사태");
  });

  it("부위가 둘 이상이거나 없으면 null이라 사람이 고른다", () => {
    expect(partNameFromItemName("등심·안심 세트")).toBeNull();
    expect(partNameFromItemName("한우 모듬")).toBeNull();
    expect(partNameFromItemName(null)).toBeNull();
    expect(partNameFromItemName("")).toBeNull();
  });
});
