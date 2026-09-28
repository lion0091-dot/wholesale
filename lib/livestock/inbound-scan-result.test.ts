import { describe, expect, it } from "vitest";
import {
  buildFailureCard,
  buildMissingInputCard,
  buildScanResultCard,
  type ScanResultInput,
  type ScanResultOptions,
} from "./inbound-scan-result";

const ok: ScanResultInput = {
  scanId: "s1",
  status: "NORMAL",
  bestBefore: null,
  daysLeft: null,
  labeledWeight: 12.5,
  weightVariance: 0,
  varianceRatio: 0,
  varianceExceeded: false,
  purchaseUnitPrice: 45000,
  purchaseAmount: 562500,
  autoCreated: null,
  failReason: null,
  failDetail: null,
  failIsNotConfigured: false,
};

const options: ScanResultOptions = {
  canSeePrice: true,
  actualWeight: 12.5,
  productName: (id) => `상품-${id}`,
  formatWon: (value) => `${value}원`,
  formatVariance: (variance, ratio) => `${variance}kg (${ratio}%)`,
};

describe("buildScanResultCard", () => {
  it("1. 정상 입고 + 단가 있음 — 초록, 매입금액을 알려 준다", () => {
    const card = buildScanResultCard(ok, options);

    expect(card.tone).toBe("green");
    expect(card.detail).toContain("562500원");
  });

  it("2. 정상 입고 + 단가 없음 — 초록, 금액이 비었다고 알린다", () => {
    const card = buildScanResultCard({ ...ok, purchaseAmount: null, purchaseUnitPrice: null }, options);

    expect(card.tone).toBe("green");
    expect(card.detail).toContain("비워 뒀습니다");
  });

  it("직원(원가 비공개)에게는 금액을 보여주지 않는다", () => {
    const card = buildScanResultCard(ok, { ...options, canSeePrice: false });

    expect(card.detail).not.toContain("원");
  });

  it("3. 상품 자동 생성 — 노랑, 상품 관리로 안내한다", () => {
    const card = buildScanResultCard({ ...ok, autoCreated: { productName: "등심 1+", needsPrice: true } }, options);

    expect(card.tone).toBe("yellow");
    expect(card.title).toContain("등심 1+");
    expect(card.action?.href).toBe("/dashboard/products");
  });

  it("4. 무게 차이 초과 — 노랑", () => {
    const card = buildScanResultCard(
      { ...ok, varianceExceeded: true, weightVariance: -1, varianceRatio: -8 },
      options,
    );

    expect(card.tone).toBe("yellow");
    expect(card.detail).toContain("매입처에 확인");
  });

  it("5·6. 유통기한 지남/임박 — 노랑, 지난 것은 출고 안 됨을 알린다", () => {
    const expired = buildScanResultCard({ ...ok, daysLeft: -2, bestBefore: "2026-09-23" }, options);
    const soon = buildScanResultCard({ ...ok, daysLeft: 2, bestBefore: "2026-09-27" }, options);

    expect(expired.title).toContain("2일 지난");
    expect(expired.detail).toContain("출고되지 않습니다");
    expect(soon.title).toContain("2일 남았습니다");
    expect(soon.tone).toBe("yellow");
  });

  it("8. 상품 확인 필요 — 빨강, 재고가 아직 안 잡혔다고 알리고 그 박스로 이동시킨다", () => {
    const card = buildScanResultCard({ ...ok, status: "PENDING_MAPPING" }, options);

    expect(card.tone).toBe("red");
    expect(card.detail).toContain("재고가 늘어납니다");
    expect(card.action?.href).toBe("#scan-s1");
  });

  it("9. 이력 못 찾음 — 빨강, 박스 나눠서 입고도 안내한다", () => {
    const card = buildScanResultCard({ ...ok, status: "EXCEPTION", failReason: "NOT_FOUND" }, options);

    expect(card.tone).toBe("red");
    expect(card.detail).toContain("박스 나눠서 입고");
  });

  it("10. 인증키 미설정 — 다시 찍어도 안 된다고 알린다", () => {
    const card = buildScanResultCard(
      { ...ok, status: "EXCEPTION", failReason: "API_ERROR", failIsNotConfigured: true },
      options,
    );

    expect(card.title).toContain("설정되지 않아");
    expect(card.detail).toContain("다시 찍어도");
  });

  it("11. 이력조회 일시 오류 — 다시 찍어 보라고 하고 사유를 보여준다", () => {
    const card = buildScanResultCard(
      { ...ok, status: "EXCEPTION", failReason: "API_ERROR", failDetail: "timeout" },
      options,
    );

    expect(card.detail).toContain("timeout");
    expect(card.detail).toContain("자동으로 다시 조회");
  });

  it("사정이 겹치면 빨강이 제목, 나머지는 덧붙인다", () => {
    const card = buildScanResultCard(
      { ...ok, status: "PENDING_MAPPING", varianceExceeded: true, weightVariance: 1, varianceRatio: 8, daysLeft: 1, bestBefore: "x" },
      options,
    );

    expect(card.tone).toBe("red");
    expect(card.extras.map((extra) => extra.tone)).toEqual(["yellow", "yellow"]);
  });
});

describe("입력 누락·실패 카드", () => {
  it("15. 이력번호/실중량이 비면 어느 칸인지 알려 준다", () => {
    expect(buildMissingInputCard("trace").title).toContain("이력번호");
    expect(buildMissingInputCard("weight").title).toContain("실중량");
  });

  it("등록 요청이 실패하면 사유를 그대로 보여준다", () => {
    expect(buildFailureCard("권한이 없습니다").detail).toBe("권한이 없습니다");
  });
});

describe("buildScanResultCard — 부위 미지정 안내", () => {
  it("부위를 몰라 만든 상품은 부위를 채우라고 안내한다", () => {
    const card = buildScanResultCard(
      { ...ok, autoCreated: { productName: "소 (부위 미지정)", needsPrice: true } },
      options
    );

    expect(card.detail).toContain("부위를 몰라 비워 뒀습니다");
    expect(card.action?.href).toBe("/dashboard/products");
  });
});

describe("발주서 판정(마이그레이션 142)이 결과 카드에 미치는 영향", () => {
  const po = (patch: Partial<NonNullable<ScanResultInput["po"]>>): NonNullable<ScanResultInput["po"]> => ({
    result: "ASSIGNED",
    reason: null,
    ordered: 50,
    received: 20,
    remaining: 30,
    tolerance: null,
    excess: null,
    orderClosed: false,
    ...patch,
  });

  it("초과로 받지 않은 박스 — 빨강, 재고에 없다는 말과 발주서로 가는 길을 준다", () => {
    const card = buildScanResultCard(
      { ...ok, status: "REJECTED", productId: "p1", po: po({ result: "REJECTED", reason: "OVER", ordered: 50, received: 50, remaining: null }) },
      options
    );

    expect(card.tone).toBe("red");
    expect(card.title).toContain("받지 않았습니다");
    expect(card.title).toContain("발주 수량을 넘었습니다");
    expect(card.detail).toContain("발주 50kg 중 이미 50kg 받았습니다");
    expect(card.detail).toContain("재고에는 넣지 않았고");
    expect(card.action?.href).toBe("/dashboard/purchase-orders");
  });

  it("발주서에 없는 물건으로 받지 않은 박스 — 제목이 없는 물건이라고 말한다", () => {
    const card = buildScanResultCard(
      { ...ok, status: "REJECTED", po: po({ result: "REJECTED", reason: "UNLISTED", ordered: null, received: null, remaining: null }) },
      options
    );

    expect(card.tone).toBe("red");
    expect(card.title).toContain("전표에 없는 물건");
  });

  it("발주서에 붙은 박스 — 초록 그대로, 받은 양과 남은 양을 덧붙인다", () => {
    const card = buildScanResultCard({ ...ok, po: po({}) }, options);

    expect(card.tone).toBe("green");
    expect(card.extras.map((extra) => extra.detail).join(" ")).toContain("발주 50kg 중 20kg 받았습니다 (남음 30kg)");
  });

  it("발주서를 다 채운 박스 — 자동 마감을 알린다", () => {
    const card = buildScanResultCard({ ...ok, po: po({ received: 50, remaining: 0, orderClosed: true }) }, options);

    expect(card.extras.map((extra) => extra.title)).toContain("전표를 다 받아 자동으로 마감했습니다");
  });

  it("없는 물건을 받아 둔 박스 — 노랑", () => {
    expect(buildScanResultCard({ ...ok, po: po({ result: "UNLISTED_HELD" }) }, options).tone).toBe("yellow");
  });

  it("초과를 받아 둔 박스 — 노랑, 재고에 들어갔다는 말과 넘친 무게를 알린다", () => {
    const card = buildScanResultCard({ ...ok, po: po({ result: "OVER_HELD", ordered: 50, received: 50, remaining: 0, excess: 12.5 }) }, options);

    expect(card.tone).toBe("yellow");

    const extra = card.extras.find((item) => item.title === "발주 수량을 넘었습니다");

    expect(extra?.detail).toContain("판매할 수 있습니다");
    expect(extra?.detail).toContain("12.5kg는 전표에 붙지 않았습니다");
  });

  it("거래처를 안 고르고 찍으면 거래처부터 고르라고 한다", () => {
    const card = buildMissingInputCard("supplier");

    expect(card.tone).toBe("red");
    expect(card.title).toContain("거래처");
  });
});
