import { describe, expect, it } from "vitest";
import { buildOrderNumber, translateHotDealQuotaError } from "@/lib/orders/create-order";

describe("translateHotDealQuotaError", () => {
  it("정상 케이스를 한글 안내문으로 바꾼다", () => {
    const message = translateHotDealQuotaError("HOT_DEAL_QUOTA_EXCEEDED:한우 등심:20:15:10");

    expect(message).toContain("한우 등심");
    expect(message).toContain("핫딜 매진");
  });

  it("상품명에 콜론이 섞여도 뒤 숫자 3개를 정확히 분리한다(회귀 테스트)", () => {
    // 코드리뷰(high)에서 발견: lazy 캡처(.*?)였을 때 콜론 포함 상품명이 깨졌다.
    const message = translateHotDealQuotaError("HOT_DEAL_QUOTA_EXCEEDED:1++:등심:20:15:10");

    expect(message).toContain("1++:등심");
  });

  it("패턴이 아닌 메시지는 null을 돌려준다", () => {
    expect(translateHotDealQuotaError("INSUFFICIENT_STOCK:돼지고기:5:10")).toBeNull();
    expect(translateHotDealQuotaError("알 수 없는 오류")).toBeNull();
  });
});

describe("buildOrderNumber", () => {
  it("ORD-YYYYMMDD-XXXXXX 형식이다", () => {
    const orderNumber = buildOrderNumber();

    expect(orderNumber).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
  });

  it("호출마다 다른 값을 만든다(랜덤 접미사)", () => {
    const a = buildOrderNumber();
    const b = buildOrderNumber();

    // 극히 드물게 같을 수 있으나(36^6분의 1) 사실상 항상 다르다.
    expect(a).not.toBe(b);
  });
});
