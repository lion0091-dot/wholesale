import { describe, expect, it } from "vitest";
import {
  buildGapReport,
  buildSupplierRequestSummary,
  sumLineAmounts,
  type DocumentHeaderInput,
  type LineResolution,
} from "@/lib/livestock/document-requirements";
import type { DocumentLine } from "@/lib/livestock/document-parser";

function makeLine(overrides: Partial<DocumentLine> = {}): DocumentLine {
  return {
    lineNo: 1,
    raw: "한우 등심 1++ 10kg 300000",
    itemName: "한우 등심",
    traceNo: "002123456789",
    partName: "등심",
    grade: "1++",
    origin: "국내산",
    quantity: 1,
    labeledWeight: 10,
    unitPrice: 30000,
    amount: 300000,
    ...overrides,
  };
}

function makeHeader(overrides: Partial<DocumentHeaderInput> = {}): DocumentHeaderInput {
  return {
    supplierName: "성실축산",
    issuedOn: "2026-09-24",
    totalAmount: 300000,
    ...overrides,
  };
}

describe("sumLineAmounts", () => {
  it("amount가 있으면 그대로 더한다", () => {
    expect(sumLineAmounts([makeLine({ amount: 100 }), makeLine({ amount: 200 })])).toBe(300);
  });

  it("amount가 없으면 단가×중량으로 계산한다", () => {
    expect(sumLineAmounts([makeLine({ amount: null, unitPrice: 30000, labeledWeight: 2 })])).toBe(60000);
  });

  it("단가나 중량마저 없으면 0으로 취급한다", () => {
    expect(sumLineAmounts([makeLine({ amount: null, unitPrice: null, labeledWeight: 2 })])).toBe(0);
  });
});

describe("buildGapReport — 문서 단위", () => {
  it("공급처명이 없으면 SUPPLIER_MISSING", () => {
    const report = buildGapReport(makeHeader({ supplierName: null }), [makeLine()]);

    expect(report.documentGaps.map((g) => g.code)).toContain("SUPPLIER_MISSING");
  });

  it("날짜가 없으면 ISSUED_ON_MISSING(RECOMMENDED)", () => {
    const report = buildGapReport(makeHeader({ issuedOn: null }), [makeLine()]);
    const gap = report.documentGaps.find((g) => g.code === "ISSUED_ON_MISSING");

    expect(gap?.level).toBe("RECOMMENDED");
  });

  it("줄이 하나도 없으면 NO_LINES", () => {
    const report = buildGapReport(makeHeader(), []);

    expect(report.documentGaps.map((g) => g.code)).toContain("NO_LINES");
  });

  it("줄 합계와 서류 합계가 1원 넘게 다르면 TOTAL_MISMATCH", () => {
    const report = buildGapReport(makeHeader({ totalAmount: 999999 }), [makeLine({ amount: 300000 })]);

    expect(report.documentGaps.map((g) => g.code)).toContain("TOTAL_MISMATCH");
  });

  it("1원 이내 반올림 차이는 무시한다", () => {
    const report = buildGapReport(makeHeader({ totalAmount: 300000.5 }), [makeLine({ amount: 300000 })]);

    expect(report.documentGaps.map((g) => g.code)).not.toContain("TOTAL_MISMATCH");
  });
});

describe("buildGapReport — 줄 단위", () => {
  it("품목명·이력번호가 둘 다 없으면 ITEM_UNKNOWN", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ itemName: null, traceNo: null })]);

    expect(report.lineGaps[0].gaps.map((g) => g.code)).toContain("ITEM_UNKNOWN");
  });

  it("품목명은 있는데 상품 연결이 안 되면 PRODUCT_UNLINKED", () => {
    const report = buildGapReport(makeHeader(), [makeLine()]);

    expect(report.lineGaps[0].gaps.map((g) => g.code)).toContain("PRODUCT_UNLINKED");
  });

  it("상품이 연결되면 PRODUCT_UNLINKED가 사라진다", () => {
    const resolutions: LineResolution[] = [{ lineNo: 1, productId: "p1", productOrigin: "국내산" }];
    const report = buildGapReport(makeHeader(), [makeLine()], resolutions);

    expect(report.lineGaps[0]?.gaps.map((g) => g.code) ?? []).not.toContain("PRODUCT_UNLINKED");
  });

  it("중량이 없으면 WEIGHT_MISSING", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ labeledWeight: null })]);

    expect(report.lineGaps[0].gaps.map((g) => g.code)).toContain("WEIGHT_MISSING");
  });

  it("단가와 금액이 둘 다 없으면 PRICE_MISSING", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ unitPrice: null, amount: null })]);

    expect(report.lineGaps[0].gaps.map((g) => g.code)).toContain("PRICE_MISSING");
  });

  it("단가나 금액 중 하나만 있으면 PRICE_MISSING이 아니다", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ unitPrice: null, amount: 300000 })]);

    expect(report.lineGaps[0]?.gaps.map((g) => g.code) ?? []).not.toContain("PRICE_MISSING");
  });

  it("이력번호가 없으면 TRACE_MISSING(RECOMMENDED)", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ traceNo: null })]);
    const gap = report.lineGaps[0].gaps.find((g) => g.code === "TRACE_MISSING");

    expect(gap?.level).toBe("RECOMMENDED");
  });

  it("등급·이력번호가 둘 다 없으면 GRADE_UNKNOWN, 이력번호만 있으면 안 걸린다", () => {
    const withoutBoth = buildGapReport(makeHeader(), [makeLine({ grade: null, traceNo: null })]);
    expect(withoutBoth.lineGaps[0].gaps.map((g) => g.code)).toContain("GRADE_UNKNOWN");

    const withTraceOnly = buildGapReport(makeHeader(), [makeLine({ grade: null, traceNo: "002123456789" })]);
    expect(withTraceOnly.lineGaps[0]?.gaps.map((g) => g.code) ?? []).not.toContain("GRADE_UNKNOWN");
  });

  it("원산지·이력번호·상품연결이 셋 다 없으면 ORIGIN_UNKNOWN", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ origin: null, traceNo: null })]);

    expect(report.lineGaps[0].gaps.map((g) => g.code)).toContain("ORIGIN_UNKNOWN");
  });

  it("이력번호만 있어도 ORIGIN_UNKNOWN이 안 걸린다", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ origin: null, traceNo: "002123456789" })]);

    expect(report.lineGaps[0]?.gaps.map((g) => g.code) ?? []).not.toContain("ORIGIN_UNKNOWN");
  });

  it("서류 원산지와 연결된 상품 원산지가 다르면 ORIGIN_MISMATCH", () => {
    const resolutions: LineResolution[] = [{ lineNo: 1, productId: "p1", productOrigin: "미국산" }];
    const report = buildGapReport(makeHeader(), [makeLine({ origin: "국내산" })], resolutions);

    expect(report.lineGaps[0].gaps.map((g) => g.code)).toContain("ORIGIN_MISMATCH");
  });

  it("모든 항목이 채워지면 해당 줄은 lineGaps에 안 들어간다", () => {
    const resolutions: LineResolution[] = [{ lineNo: 1, productId: "p1", productOrigin: "국내산" }];
    const report = buildGapReport(makeHeader(), [makeLine()], resolutions);

    expect(report.lineGaps).toHaveLength(0);
    expect(report.incompleteLineCount).toBe(0);
  });

  it("REQUIRED 위반이 있는 줄만 incompleteLineCount에 센다", () => {
    const resolutions: LineResolution[] = [
      { lineNo: 1, productId: "p1", productOrigin: "국내산" },
      { lineNo: 2, productId: "p1", productOrigin: "국내산" },
    ];
    const report = buildGapReport(
      makeHeader(),
      [
        makeLine({ lineNo: 1, traceNo: null }), // RECOMMENDED만 걸림 (TRACE_MISSING)
        makeLine({ lineNo: 2, labeledWeight: null }), // REQUIRED 걸림 (WEIGHT_MISSING)
      ],
      resolutions,
    );

    expect(report.incompleteLineCount).toBe(1);
    expect(report.totalLineCount).toBe(2);
  });
});

describe("buildSupplierRequestSummary", () => {
  it("FROM_SUPPLIER 소스의 항목만, 중복 없이 추린다", () => {
    const report = buildGapReport(makeHeader({ supplierName: null }), [
      makeLine({ lineNo: 1, labeledWeight: null }),
      makeLine({ lineNo: 2, labeledWeight: null }),
    ]);

    const summary = buildSupplierRequestSummary(report);

    expect(summary).toContain("중량이 적혀 있지 않습니다");
    expect(summary).not.toContain("어느 공급처에서 온 서류인지 적어주세요");
    expect(summary.filter((label) => label === "중량이 적혀 있지 않습니다")).toHaveLength(1);
  });
});

describe("이력번호 축종코드 진단 (첫 자리: 소0·돼지1·닭2·계란3·오리5)", () => {
  const codes = (line: DocumentLine) => buildGapReport(makeHeader(), [line]).lineGaps.flatMap((entry) => entry.gaps.map((gap) => gap.code));

  it("번호의 축종과 품목명의 축종이 같으면 아무것도 짚지 않는다", () => {
    expect(codes(makeLine({ itemName: "한우 등심", traceNo: "002123456789" }))).not.toContain("TRACE_SPECIES_MISMATCH");
    expect(codes(makeLine({ itemName: "돼지 삼겹살", traceNo: "140077000150", origin: "국내산" }))).not.toContain("TRACE_SPECIES_MISMATCH");
  });

  it("번호는 돼지(1)인데 품목은 한우면 짚는다 — 막지는 않고 권고 수준", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ itemName: "한우 등심", traceNo: "140077000150" })]);
    const gap = report.lineGaps[0].gaps.find((item) => item.code === "TRACE_SPECIES_MISMATCH");

    expect(gap?.level).toBe("RECOMMENDED");
    expect(gap?.label).toContain("돼지");
    expect(gap?.label).toContain("소");
  });

  it("품목명에 축종 단어가 없으면(부위만) 판단하지 않는다", () => {
    expect(codes(makeLine({ itemName: "갈비", partName: "갈비", traceNo: "140077000150" }))).not.toContain("TRACE_SPECIES_MISMATCH");
  });

  it("12자리인데 첫 자리가 축종코드가 아니면 번호를 다시 확인하라고 짚는다", () => {
    const report = buildGapReport(makeHeader(), [makeLine({ traceNo: "912345678901" })]);
    const gap = report.lineGaps[0].gaps.find((item) => item.code === "TRACE_CODE_UNKNOWN");

    expect(gap?.label).toContain("첫 자리(9)");
  });

  it("15자리 묶음번호·L 접두어 묶음번호는 구조 검사 대상이 아니다", () => {
    expect(codes(makeLine({ traceNo: "L01234567890123" }))).not.toContain("TRACE_CODE_UNKNOWN");
    expect(codes(makeLine({ traceNo: "123456789012345" }))).not.toContain("TRACE_CODE_UNKNOWN");
  });
});
