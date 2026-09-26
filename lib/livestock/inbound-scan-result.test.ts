import { describe, expect, it } from "vitest";
import {
  buildFailureCard,
  buildMissingInputCard,
  buildScanResultCard,
  withDocumentContext,
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
  productConflict: null,
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

  it("7. 바코드 상품과 전표 상품 충돌 — 두 상품 이름을 보여준다", () => {
    const card = buildScanResultCard(
      { ...ok, productConflict: { gtinProductId: "a", documentProductId: "b" } },
      options,
    );

    expect(card.detail).toContain("상품-a");
    expect(card.detail).toContain("상품-b");
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

describe("withDocumentContext", () => {
  it("13. 대기 전표가 있는데 어느 줄과도 안 이어졌으면 초록을 노랑으로 올리고 안내를 덧붙인다", () => {
    const card = withDocumentContext(buildScanResultCard(ok, options), { hasPendingDocument: true, documentMatched: false });

    expect(card.tone).toBe("yellow");
    expect(card.extras.at(-1)?.title).toContain("전표에 없는 번호");
  });

  it("전표와 이어졌으면 그대로 둔다", () => {
    const base = buildScanResultCard(ok, options);

    expect(withDocumentContext(base, { hasPendingDocument: true, documentMatched: true })).toEqual(base);
  });

  it("14. 대기 전표가 없으면 초록 카드에 '전표 없이 입고' 안내를 덧붙인다", () => {
    const card = withDocumentContext(buildScanResultCard(ok, options), { hasPendingDocument: false, documentMatched: null });

    expect(card.tone).toBe("green");
    expect(card.extras.at(-1)?.title).toContain("전표 없이");
  });

  it("빨강 카드에는 전표 없음 안내를 덧붙이지 않는다", () => {
    const red = buildScanResultCard({ ...ok, status: "PENDING_MAPPING" }, options);

    expect(withDocumentContext(red, { hasPendingDocument: false, documentMatched: null })).toEqual(red);
  });
});

describe("buildScanResultCard — 자동 마감·부위 미지정 안내", () => {
  it("이 박스로 전표가 자동 마감되면 결과 카드가 그 사실을 함께 알린다", () => {
    const card = buildScanResultCard({ ...ok, autoClosedDocument: true }, options);

    expect(card.tone).toBe("green");
    expect(card.extras.map((extra) => extra.title)).toContain("전표를 저절로 마감했습니다");
  });

  it("자동 마감이 아니면 그 안내는 없다", () => {
    expect(buildScanResultCard(ok, options).extras).toEqual([]);
  });

  it("부위를 몰라 만든 상품은 부위를 채우라고 안내한다", () => {
    const card = buildScanResultCard(
      { ...ok, autoCreated: { productName: "소 (부위 미지정)", needsPrice: true } },
      options
    );

    expect(card.detail).toContain("부위를 몰라 비워 뒀습니다");
    expect(card.action?.href).toBe("/dashboard/products");
  });
});
