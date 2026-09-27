import { describe, expect, it } from "vitest";
import { findSupplierCollision, parseAliases, validateSupplierInput } from "./suppliers";

const form = (patch: Partial<Parameters<typeof validateSupplierInput>[0]> = {}) => ({ name: "대성축산", phone: "", note: "", aliases: "", ...patch });

describe("parseAliases", () => {
  it("쉼표·줄바꿈으로 나누고 공백을 다듬고 열쇠가 같은 것은 하나만 남긴다", () => {
    expect(parseAliases("대성 축산, 대성축산\n DS축산 ,,")).toEqual(["대성 축산", "DS축산"]);
    expect(parseAliases("")).toEqual([]);
  });
});

describe("validateSupplierInput", () => {
  it("정상 입력은 다듬어서 통과시키고 이름과 같은 별칭은 뺀다", () => {
    expect(validateSupplierInput(form({ name: "  대성   축산 ", phone: " 010-1 ", aliases: "대성축산, DS축산" }))).toEqual({
      ok: true,
      value: { name: "대성 축산", phone: "010-1", note: null, aliases: ["DS축산"] },
    });
  });

  it("이름·길이 오류를 각각 안내문으로 거부한다", () => {
    const cases: Array<[Partial<ReturnType<typeof form>>, string]> = [
      [{ name: "   " }, "이름을 입력"],
      [{ name: "가".repeat(81) }, "80자"],
      [{ phone: "1".repeat(31) }, "30자"],
      [{ note: "가".repeat(501) }, "500자"],
      [{ aliases: Array.from({ length: 11 }, (_, index) => `별칭${index}`).join(",") }, "10개"],
    ];

    for (const [patch, message] of cases) {
      const result = validateSupplierInput(form(patch));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain(message);
    }
  });
});

describe("findSupplierCollision", () => {
  const others = [
    { id: "a", name: "OO축산", aliases: ["오오 축산"] },
    { id: "b", name: "한우농장", aliases: [] },
  ];

  it("다른 거래처의 이름·별칭과 공백·대소문자만 달라도 겹침으로 잡고, 자기 자신은 건너뛴다", () => {
    expect(findSupplierCollision({ name: "oo 축산", aliases: [] }, others)).toContain("OO축산");
    expect(findSupplierCollision({ name: "새곳", aliases: ["오오축산"] }, others)).toContain("OO축산");
    expect(findSupplierCollision({ name: "OO축산", aliases: [] }, others, "a")).toBeNull();
    expect(findSupplierCollision({ name: "새곳", aliases: ["다른이름"] }, others)).toBeNull();
  });
});
