import { describe, expect, it } from "vitest";
import { isEncodableCode128B, renderCode128Svg, validatePatternTable } from "@/lib/livestock/code128";

describe("validatePatternTable", () => {
  it("패턴표가 규격(모듈 합)을 만족한다", () => {
    expect(validatePatternTable()).toEqual([]);
  });
});

describe("isEncodableCode128B", () => {
  it("아스키 32~126 범위 문자열은 인코딩 가능", () => {
    expect(isEncodableCode128B("002123456789")).toBe(true);
    expect(isEncodableCode128B("SET-260924-001")).toBe(true);
    expect(isEncodableCode128B("L12345678901234")).toBe(true);
  });

  it("빈 문자열은 인코딩 불가", () => {
    expect(isEncodableCode128B("")).toBe(false);
  });

  it("한글 등 아스키 범위 밖 문자가 섞이면 인코딩 불가", () => {
    expect(isEncodableCode128B("이력번호123")).toBe(false);
  });
});

describe("renderCode128Svg", () => {
  it("유효한 값은 SVG 문자열을 돌려준다", () => {
    const svg = renderCode128Svg("002123456789");

    expect(svg).not.toBeNull();
    expect(svg).toContain("<svg");
    expect(svg).toContain("rect");
  });

  it("인코딩 불가한 값은 null을 돌려준다(폴백은 호출부가 글자만 찍음)", () => {
    expect(renderCode128Svg("이력번호")).toBeNull();
    expect(renderCode128Svg("")).toBeNull();
  });

  it("moduleWidth·height 옵션을 반영한다", () => {
    const svg = renderCode128Svg("SET-260924-001", { moduleWidth: 3, height: 60 });

    expect(svg).toContain('height="60"');
  });
});
