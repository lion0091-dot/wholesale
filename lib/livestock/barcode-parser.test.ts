import { describe, expect, it } from "vitest";
import { parseBarcode } from "@/lib/livestock/barcode-parser";

describe("parseBarcode", () => {
  it("순수 이력번호(12자리)를 인식한다", () => {
    const result = parseBarcode("002123456789");

    expect(result.format).toBe("plain");
    expect(result.traceNo).toBe("002123456789");
  });

  it("묶음번호(15자리 또는 L+14자리)를 인식한다", () => {
    expect(parseBarcode("123456789012345").traceNo).toBe("123456789012345");
    expect(parseBarcode("L12345678901234").format).toBe("plain");
  });

  it("QR(URL)에서 이력번호를 뽑아낸다", () => {
    const result = parseBarcode("https://mtrace.go.kr/lookup?traceNo=002123456789");

    expect(result.format).toBe("url");
    expect(result.traceNo).toBe("002123456789");
  });

  it("GS1-128: AI(01) GTIN + AI(251) 이력번호를 뽑아낸다", () => {
    // AI 01 = GTIN 14자리(고정), AI 251 = 가변길이(끝까지) 원산지 추적코드(이력번호로 씀)
    const raw = "0108801234567893251002123456789";
    const result = parseBarcode(raw);

    expect(result.format).toBe("gs1");
    expect(result.gtin).toBe("08801234567893");
    expect(result.traceNo).toBe("002123456789");
  });

  it("빈 문자열은 unknown이고 이력번호가 없다", () => {
    const result = parseBarcode("");

    expect(result.format).toBe("unknown");
    expect(result.traceNo).toBeNull();
  });

  it("알 수 없는 형식은 문자열 안에서 이력번호를 폴백으로 찾는다", () => {
    const result = parseBarcode("메모: 002123456789 (냉장)");

    expect(result.traceNo).toBe("002123456789");
    expect(result.format).toBe("unknown");
  });
});
