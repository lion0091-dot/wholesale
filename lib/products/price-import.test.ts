import { describe, expect, it } from "vitest";
import { buildPriceCsv, parsePriceCsv, PRICE_CSV_HEADERS, type PriceCsvProduct } from "@/lib/products/price-import";

function makeCsvProduct(overrides: Partial<PriceCsvProduct> = {}): PriceCsvProduct {
  return {
    id: "product-1",
    name: "한우 등심",
    category: "소",
    subcategory: "등심",
    grade: "1++",
    unit: "kg",
    basePrice: 30000,
    marketPrice: 28000,
    ...overrides,
  };
}

describe("buildPriceCsv", () => {
  it("헤더 행과 BOM을 포함한다", () => {
    const csv = buildPriceCsv([]);

    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain(PRICE_CSV_HEADERS.join(","));
  });

  it("판매가 칸은 비워서 내보낸다", () => {
    const csv = buildPriceCsv([makeCsvProduct()]);
    const lines = csv.trim().split("\n");

    expect(lines[1].endsWith(",")).toBe(true);
  });

  it("null 필드는 빈 칸으로, 쉼표/따옴표 포함 값은 이스케이프한다", () => {
    const csv = buildPriceCsv([
      makeCsvProduct({ subcategory: null, grade: null, marketPrice: null, name: '한우, "등심"' }),
    ]);

    expect(csv).toContain('"한우, ""등심"""');
  });
});

describe("parsePriceCsv", () => {
  const validId = "12345678-1234-1234-1234-123456789012";

  it("정상적인 CSV를 파싱해 filledCount/errorCount를 계산한다", () => {
    const csv = `상품ID,상품명,판매가\n${validId},한우 등심,35000\n`;
    const result = parsePriceCsv(csv);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: validId, price: 35000, error: null });
    expect(result.filledCount).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it("탭 구분 파일도 처리한다", () => {
    const csv = `상품ID\t상품명\t판매가\n${validId}\t한우 등심\t35000\n`;
    const result = parsePriceCsv(csv);

    expect(result.rows[0].price).toBe(35000);
  });

  it("'68,000원' 같은 표기를 숫자로 바꾼다", () => {
    const csv = `상품ID,판매가\n${validId},"68,000원"\n`;
    const result = parsePriceCsv(csv);

    expect(result.rows[0].price).toBe(68000);
  });

  it("빈 판매가 칸은 price=null(건너뜀)로 처리하고 에러로 세지 않는다", () => {
    const csv = `상품ID,판매가\n${validId},\n`;
    const result = parsePriceCsv(csv);

    expect(result.rows[0].price).toBeNull();
    expect(result.filledCount).toBe(0);
    expect(result.errorCount).toBe(0);
  });

  it("0 이하 판매가는 무효 처리한다", () => {
    const csv = `상품ID,판매가\n${validId},0\n`;
    const result = parsePriceCsv(csv);

    expect(result.rows[0].price).toBeNull();
  });

  it("상품ID가 UUID 형식이 아니면 행 단위 에러를 남긴다", () => {
    const csv = `상품ID,판매가\nnot-a-uuid,35000\n`;
    const result = parsePriceCsv(csv);

    expect(result.rows[0].error).toBe("상품ID가 올바르지 않습니다");
    expect(result.errorCount).toBe(1);
  });

  it("필수 칸(상품ID/판매가)이 없으면 문서 단위 에러 한 행을 돌려준다", () => {
    const csv = `상품명,단위\n한우 등심,kg\n`;
    const result = parsePriceCsv(csv);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].error).toContain("상품ID");
    expect(result.errorCount).toBe(1);
  });

  it("빈 문서는 빈 결과를 돌려준다", () => {
    expect(parsePriceCsv("")).toEqual({ rows: [], filledCount: 0, errorCount: 0 });
  });

  it("칸 순서가 바뀌어도 헤더 이름으로 찾는다", () => {
    const csv = `판매가,상품ID\n40000,${validId}\n`;
    const result = parsePriceCsv(csv);

    expect(result.rows[0]).toMatchObject({ id: validId, price: 40000 });
  });
});
