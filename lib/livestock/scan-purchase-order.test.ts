import { describe, expect, it } from "vitest";
import { rejectionSummary, scanPurchaseOrderFromDb } from "./scan-purchase-order";

describe("scanPurchaseOrderFromDb", () => {
  it("DB가 돌려준 판정 JSON을 화면용 모양으로 바꾼다", () => {
    expect(
      scanPurchaseOrderFromDb({ result: "ASSIGNED", ordered: "50", received: 20, remaining: 30, order_closed: true })
    ).toEqual({ result: "ASSIGNED", reason: null, ordered: 50, received: 20, remaining: 30, tolerance: null, excess: null, orderClosed: true });
  });

  it("거절이면 사유와 허용 오차를 싣는다", () => {
    expect(scanPurchaseOrderFromDb({ result: "REJECTED", reason: "OVER", ordered: 50, received: 50, tolerance: 5 })).toMatchObject({
      result: "REJECTED",
      reason: "OVER",
      tolerance: 5,
    });
  });

  it("초과를 받아 둔 박스(OVER_HELD)는 넘친 무게를 싣는다", () => {
    expect(scanPurchaseOrderFromDb({ result: "OVER_HELD", ordered: 50, received: 50, remaining: 0, tolerance: 0, excess: "12.5" })).toMatchObject({
      result: "OVER_HELD",
      excess: 12.5,
    });
  });

  it("판정 대상이 아니면(SKIPPED·없음·이상한 값) null", () => {
    expect(scanPurchaseOrderFromDb({ result: "SKIPPED" })).toBeNull();
    expect(scanPurchaseOrderFromDb(null)).toBeNull();
    expect(scanPurchaseOrderFromDb("x")).toBeNull();
  });
});

describe("rejectionSummary", () => {
  it("초과는 발주량과 이미 받은 양을 말한다", () => {
    const text = rejectionSummary({ result: "REJECTED", reason: "OVER", ordered: 50, received: 48.5, remaining: null, tolerance: 0, excess: null, orderClosed: false });

    expect(text).toContain("발주 50kg 중 이미 48.5kg 받았습니다");
  });

  it("없는 물건은 발주서에 없다고 말한다", () => {
    const text = rejectionSummary({ result: "REJECTED", reason: "UNLISTED", ordered: null, received: null, remaining: null, tolerance: null, excess: null, orderClosed: false });

    expect(text).toContain("발주서에 없는 물건");
  });
});
