import { describe, expect, it } from "vitest";
import { findMissingStatementFields, findMissingTaxInvoiceFields, type StatementData } from "@/lib/orders/statement";

function makeStatementData(overrides: Partial<StatementData> = {}): StatementData {
  return {
    orderId: "order-1",
    orderNumber: "ORD-20260924-TEST01",
    status: "confirmed",
    orderedAt: "2026-09-24T00:00:00Z",
    deliveryAddress: "서울특별시 강남구 테스트로 123",
    deliveryNotes: null,
    totalAmount: 100000,
    items: [],
    traces: [],
    supplier: {
      name: "테스트 도매상회",
      representativeName: "김도매",
      businessNumber: "123-45-67890",
      address: "서울특별시 송파구 도매로 45",
      phone: "010-1111-2222",
    },
    buyer: {
      name: "테스트 식당",
      representativeName: "이소매",
      businessNumber: null,
      address: "서울특별시 강남구 테스트로 123",
      phone: "010-3333-4444",
    },
    ...overrides,
  };
}

describe("findMissingStatementFields", () => {
  it("공급사 주소가 있으면 발행 가능(빈 배열)", () => {
    expect(findMissingStatementFields(makeStatementData())).toEqual([]);
  });

  it("공급사 주소가 없으면 발행을 막는다", () => {
    const data = makeStatementData({ supplier: { ...makeStatementData().supplier, address: null } });

    expect(findMissingStatementFields(data)).toContain("공급사(도매) 사업장 주소");
  });

  it("고객 사업자번호가 없어도 거래명세서는 발행 가능(비사업자 고객 허용)", () => {
    const data = makeStatementData({ buyer: { ...makeStatementData().buyer, businessNumber: null } });

    expect(findMissingStatementFields(data)).toEqual([]);
  });
});

describe("findMissingTaxInvoiceFields", () => {
  it("계산서는 고객 사업자번호도 필수다", () => {
    const data = makeStatementData({ buyer: { ...makeStatementData().buyer, businessNumber: null } });

    expect(findMissingTaxInvoiceFields(data)).toContain("고객(소매) 사업자등록번호");
  });

  it("공급사 주소 + 고객 사업자번호가 둘 다 있으면 발행 가능", () => {
    const data = makeStatementData({ buyer: { ...makeStatementData().buyer, businessNumber: "123-45-67890" } });

    expect(findMissingTaxInvoiceFields(data)).toEqual([]);
  });
});
