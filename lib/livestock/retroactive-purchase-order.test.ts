import { describe, expect, it } from "vitest";
import { retroactivePurchaseOrderFromDb } from "./retroactive-purchase-order";

describe("retroactivePurchaseOrderFromDb", () => {
  it("보류함 경로(발주서 추가 생성)의 결과를 옮긴다", () => {
    expect(retroactivePurchaseOrderFromDb({ order_id: "o1", line_id: "l1", amount: "12.5" })).toEqual({
      orderId: "o1",
      lineId: "l1",
      amount: 12.5,
    });
  });

  it("빈 값이면 기본값(빈 문자열·0)으로 채운다", () => {
    expect(retroactivePurchaseOrderFromDb(null)).toEqual({ orderId: "", lineId: "", amount: 0 });
  });
});
