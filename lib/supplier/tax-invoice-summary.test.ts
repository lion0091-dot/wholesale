import { describe, expect, it } from "vitest";
import { buildTaxInvoiceCsv, csvCell, summarizeTaxInvoices, type FetchTaxInvoiceSummaryResult } from "./tax-invoice-summary";

describe("summarizeTaxInvoices", () => {
  it("줄이 없으면 전부 0", () => {
    expect(summarizeTaxInvoices([])).toEqual({
      issuedCount: 0,
      issuedAmount: 0,
      correctedCount: 0,
      pendingCount: 0,
      failedCount: 0,
    });
  });

  it("건수와 금액을 칸별로 더한다", () => {
    expect(
      summarizeTaxInvoices([
        { issuedCount: 2, issuedAmount: 300000, correctedCount: 1, pendingCount: 0, failedCount: 1 },
        { issuedCount: 1, issuedAmount: 50000, correctedCount: 0, pendingCount: 2, failedCount: 0 },
      ])
    ).toEqual({ issuedCount: 3, issuedAmount: 350000, correctedCount: 1, pendingCount: 2, failedCount: 1 });
  });
});

describe("csvCell", () => {
  it("쉼표·따옴표·줄바꿈이 있으면 감싸고 따옴표는 두 번 쓴다", () => {
    expect(csvCell('가,"나"')).toBe('"가,""나"""');
    expect(csvCell("줄\n바꿈")).toBe('"줄\n바꿈"');
  });

  it("수식으로 읽힐 수 있는 첫 글자는 앞에 작은따옴표를 붙인다", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@a")).toBe("'@a");
  });

  it("숫자와 일반 글자는 그대로", () => {
    expect(csvCell(360000)).toBe("360000");
    expect(csvCell("식당")).toBe("식당");
  });
});

describe("buildTaxInvoiceCsv", () => {
  const result: FetchTaxInvoiceSummaryResult = {
    months: [{ monthStart: "2026-10-01", issuedCount: 1, issuedAmount: 360000, correctedCount: 0, pendingCount: 1, failedCount: 0 }],
    retailers: [{ retailerId: "r1", retailerName: "맛있는식당", issuedCount: 1, issuedAmount: 360000, correctedCount: 0, pendingCount: 1, failedCount: 0 }],
    todo: [
      { kind: "failed", orderId: "o1", orderNumber: "ORD-1", retailerName: "맛있는식당", totalAmount: 50000, happenedAt: "2026-10-03T01:00:00Z", errorMessage: "팝빌 오류, 재시도" },
      { kind: "missing", orderId: "o2", orderNumber: "ORD-2", retailerName: "다른식당", totalAmount: 10000, happenedAt: "2026-10-02T01:00:00Z", errorMessage: null },
    ],
    todoTotal: 2,
  };

  it("맨 앞에 BOM, 줄은 CRLF, 월은 YYYY-MM", () => {
    const csv = buildTaxInvoiceCsv("months", result);

    expect(csv.startsWith("﻿월,발행 건수,")).toBe(true);
    expect(csv).toContain("\r\n2026-10,1,360000,0,1,0\r\n");
  });

  it("거래처별", () => {
    expect(buildTaxInvoiceCsv("retailers", result)).toContain("맛있는식당,1,360000,0,1,0");
  });

  it("챙길 주문은 구분 이름과 실패 사유를 담는다(쉼표 있는 사유는 감싼다)", () => {
    const csv = buildTaxInvoiceCsv("todo", result);

    expect(csv).toContain('발행 실패,ORD-1,맛있는식당,50000,2026-10-03T01:00:00Z,"팝빌 오류, 재시도"');
    expect(csv).toContain("계산서 없음,ORD-2,다른식당,10000,2026-10-02T01:00:00Z,");
  });
});
