import { describe, expect, it } from "vitest";
import { retroactivePurchaseOrderFromDb } from "./retroactive-purchase-order";

describe("retroactivePurchaseOrderFromDb", () => {
  it("보류함 경로(전표도 같이 만듦)의 결과를 옮긴다", () => {
    expect(
      retroactivePurchaseOrderFromDb({ order_id: "o1", line_id: "l1", amount: "12.5", document_id: "d1" })
    ).toEqual({ orderId: "o1", lineId: "l1", amount: 12.5, documentId: "d1" });
  });

  it("전표 대조 경로(전표가 이미 있어 document_id 없음)는 documentId가 null", () => {
    expect(retroactivePurchaseOrderFromDb({ order_id: "o2", line_id: "l2", amount: 8 })).toEqual({
      orderId: "o2",
      lineId: "l2",
      amount: 8,
      documentId: null,
    });
  });

  it("빈 값이면 기본값(빈 문자열·0·null)으로 채운다", () => {
    expect(retroactivePurchaseOrderFromDb(null)).toEqual({ orderId: "", lineId: "", amount: 0, documentId: null });
  });
});
