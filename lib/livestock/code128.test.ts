import { describe, expect, it } from "vitest";
import { renderCode128Svg } from "@/lib/livestock/code128";

describe("renderCode128Svg", () => {
  it("유효한 값은 SVG 문자열을 돌려준다", () => {
    const svg = renderCode128Svg("002123456789");

    expect(svg).not.toBeNull();
    expect(svg).toContain("<svg");
  });

  it("빈 값은 null을 돌려준다(폴백은 호출부가 글자만 찍음)", () => {
    expect(renderCode128Svg("")).toBeNull();
  });

  it("moduleWidth 옵션을 받아도 오류 없이 생성된다", () => {
    const svg = renderCode128Svg("SET-260924-001", { moduleWidth: 3, height: 60 });

    expect(svg).not.toBeNull();
    expect(svg).toContain("<svg");
  });
});
