import { describe, expect, it } from "vitest";
import { cancelRequestPush, creditExceededPush, newOrderPush, orderEditedPush, shrinkagePush } from "./push-messages";

describe("웹푸시 문구", () => {
  it("새 주문 — 거래처·품목·금액, 같은 주문은 같은 tag", () => {
    const message = newOrderPush({ restaurantName: "식당A", orderNumber: "ORD-1", itemsSummary: "한우 등심 2kg 외 1건", totalAmount: 136000 });

    expect(message.title).toBe("새 주문 · 식당A");
    expect(message.body).toBe("한우 등심 2kg 외 1건 · 136,000원");
    expect(message.url).toBe("/dashboard/orders");
    expect(message.tag).toBe("order:ORD-1");
    expect(orderEditedPush({ restaurantName: "식당A", orderNumber: "ORD-1", itemsSummary: "x", totalAmount: 1 }).tag).toBe("order:ORD-1");
  });

  it("취소 요청 — 사유가 비면 생략", () => {
    expect(cancelRequestPush({ restaurantName: "식당A", orderNumber: "ORD-1", totalAmount: 50000, cancelReason: "중복 주문" }).body).toBe(
      "50,000원 · 사유: 중복 주문 — 승인 또는 반려해 주세요"
    );
    expect(cancelRequestPush({ restaurantName: "식당A", orderNumber: "ORD-1", totalAmount: 50000, cancelReason: " " }).body).toBe(
      "50,000원 — 승인 또는 반려해 주세요"
    );
  });

  it("박스 감량 — 중량·이력번호만, 금액은 싣지 않는다", () => {
    const message = shrinkagePush({ productName: "한우 등심", weightKg: 0.5, traceNo: "088800000001", orderNumber: "ORD-9", actorName: "홍길동" });

    expect(message.title).toBe("박스 감량 처리 · 한우 등심 0.5kg");
    expect(message.body).toContain("처리: 홍길동");
    expect(message.body).toContain("088800000001");
    expect(message.body).toContain("ORD-9");
    expect(message.body).not.toContain("원");
    expect(message.url).toBe("/dashboard/stock-expiring");
    expect(shrinkagePush({ productName: "x", weightKg: 1, traceNo: "T", orderNumber: null, actorName: null }).body).not.toContain("주문");
    expect(shrinkagePush({ productName: "x", weightKg: 1, traceNo: "T", orderNumber: null, actorName: " " }).body).toContain("처리: 알 수 없음");
  });

  it("여신 초과 — 미수금 화면으로", () => {
    const message = creditExceededPush({ restaurantName: "식당A", attemptedAmount: 300000, outstandingBalance: 850000 });

    expect(message.url).toBe("/dashboard/receivables");
    expect(message.body).toContain("300,000원");
    expect(message.body).toContain("850,000원");
  });
});
