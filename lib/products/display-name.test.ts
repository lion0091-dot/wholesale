import { describe, expect, it } from "vitest";
import { composeProductDisplayName } from "@/lib/products/display-name";

describe("composeProductDisplayName", () => {
  it("축종이 있으면 대괄호 태그를 붙인다", () => {
    expect(composeProductDisplayName("소", "등심")).toBe("[소] 등심");
  });

  it("축종이 없으면 상품명만 그대로 돌려준다", () => {
    expect(composeProductDisplayName(null, "등심")).toBe("등심");
    expect(composeProductDisplayName(undefined, "등심")).toBe("등심");
    expect(composeProductDisplayName("", "등심")).toBe("등심");
  });
});
