import { describe, expect, it } from "vitest";
import { normalizeImportedOrigin } from "@/lib/products/origin-options";

describe("normalizeImportedOrigin — DB trace_origin()과 같은 값", () => {
  it("목록의 나라는 '○○산'으로 옮긴다", () => {
    expect(normalizeImportedOrigin("미국")).toBe("미국산");
    expect(normalizeImportedOrigin("미국산")).toBe("미국산");
    expect(normalizeImportedOrigin(" 호주 ")).toBe("호주산");
    expect(normalizeImportedOrigin("뉴질랜드")).toBe("뉴질랜드산");
  });

  it("목록에 없는 나라와 빈 값은 기타 수입산", () => {
    expect(normalizeImportedOrigin("프랑스")).toBe("기타 수입산");
    expect(normalizeImportedOrigin("")).toBe("기타 수입산");
    expect(normalizeImportedOrigin(null)).toBe("기타 수입산");
  });
});
