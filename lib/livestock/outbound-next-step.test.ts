import { describe, expect, it } from "vitest";
import { pickOutboundGuide, type OutboundGuideInput, type OutboundGuideKey } from "./outbound-next-step";

const base: OutboundGuideInput = {
  orderCount: 2,
  openOrderCount: 2,
  selected: { status: "confirmed", finalized: false },
  progress: [{ orderedQty: 4, scannedQty: 0 }],
};

describe("pickOutboundGuide", () => {
  it("발주서가 하나도 없으면 발주 관리에서 확정하라고 안내하고 그리로 데려간다", () => {
    const guide = pickOutboundGuide({ ...base, orderCount: 0, openOrderCount: 0, selected: null, progress: [] });

    expect(guide.key).toBe("no-orders");
    expect(guide.action).toMatchObject({ kind: "link", href: "/dashboard/orders" });
  });

  it("발주서를 아직 안 골랐으면 고르라고 안내한다(전부 마감된 경우는 새 발주서를 기다리라고)", () => {
    expect(pickOutboundGuide({ ...base, selected: null, progress: [] }).detail).toContain("고르면");
    expect(pickOutboundGuide({ ...base, openOrderCount: 0, selected: null, progress: [] }).detail).toContain("모두 마감");
  });

  it("마감된 발주서를 골랐으면 더 못 찍는다고 하고 다음 발주서로 안내한다", () => {
    const guide = pickOutboundGuide({ ...base, selected: { status: "shipping", finalized: true } });

    expect(guide.key).toBe("finalized");
    expect(guide.detail).toContain("다음 발주서");
    expect(guide.action).toBeUndefined();
  });

  it("재고 확보 대기 발주서는 마감이 확정 뒤라고 알리고 마감 버튼을 주지 않는다", () => {
    const guide = pickOutboundGuide({ ...base, selected: { status: "awaiting_stock", finalized: false } });

    expect(guide.key).toBe("awaiting-stock");
    expect(guide.action?.kind).toBe("link");
  });

  it("아직 하나도 안 찍었으면 찍으라고 하되, 안 찍고 마감하면 추천 박스가 나간다고 알린다", () => {
    const guide = pickOutboundGuide(base);

    expect(guide.key).toBe("scan-first");
    expect(guide.detail).toContain("추천");
  });

  it("일부만 찍었으면 남은 상품을 안내하고 마감 버튼을 함께 준다", () => {
    const guide = pickOutboundGuide({ ...base, progress: [{ orderedQty: 4, scannedQty: 4 }, { orderedQty: 3, scannedQty: 1 }] });

    expect(guide.key).toBe("scan-more");
    expect(guide.action).toMatchObject({ kind: "finalize" });
  });

  it("전부 채웠으면 '출고 마감'을 누르라고 큰 버튼으로 안내한다", () => {
    const guide = pickOutboundGuide({ ...base, progress: [{ orderedQty: 4, scannedQty: 4 }, { orderedQty: 3, scannedQty: 3.5 }] });

    expect(guide.key).toBe("finalize");
    expect(guide.title).toContain("출고 마감");
    expect(guide.action).toMatchObject({ kind: "finalize" });
  });
});

describe("pickOutboundGuide — 모든 상태 조합의 규칙(따라가기 끊김 점검)", () => {
  const selecteds: OutboundGuideInput["selected"][] = [
    null,
    { status: "confirmed", finalized: false },
    { status: "confirmed", finalized: true },
    { status: "shipping", finalized: false },
    { status: "shipping", finalized: true },
    { status: "awaiting_stock", finalized: false },
  ];
  const progresses: OutboundGuideInput["progress"][] = [
    [],
    [{ orderedQty: 4, scannedQty: 0 }],
    [{ orderedQty: 4, scannedQty: 2 }],
    [{ orderedQty: 4, scannedQty: 4 }],
    [{ orderedQty: 4, scannedQty: 4 }, { orderedQty: 2, scannedQty: 0 }],
  ];
  const combos: OutboundGuideInput[] = [];

  for (const orderCount of [0, 3]) {
    for (const openOrderCount of [0, 2]) {
      for (const selected of selecteds) {
        for (const progress of progresses) {
          combos.push({ orderCount, openOrderCount, selected, progress });
        }
      }
    }
  }

  const keys = new Set<OutboundGuideKey>();

  it.each(combos.map((input, index) => [index, input] as const))("조합 %i", (_index, input) => {
    const guide = pickOutboundGuide(input);

    keys.add(guide.key);

    // 어떤 상태에서도 제목과 할 일 설명이 비지 않는다.
    expect(guide.title.length).toBeGreaterThan(0);
    expect(guide.detail.length).toBeGreaterThan(0);

    // 마감 버튼은 마감할 수 있는 발주서(마감 전 + 재고 확보 대기 아님)에서만.
    if (guide.action?.kind === "finalize") {
      expect(input.selected).not.toBeNull();
      expect(input.selected!.finalized).toBe(false);
      expect(input.selected!.status).not.toBe("awaiting_stock");
    }

    // 다른 화면으로 가는 버튼은 갈 곳이 있다.
    if (guide.action?.kind === "link") {
      expect(guide.action.href).toMatch(/^\//);
    }

    // 마감된 발주서와 발주서 없음은 사람이 눌러야 할 동작 없이 "다음에 무엇을 할지"만 말한다.
    if (guide.key === "finalized") expect(guide.action).toBeUndefined();
  });

  it("일곱 가지 안내가 모두 실제로 나온다(도달할 수 없는 상태가 없다)", () => {
    for (const input of combos) keys.add(pickOutboundGuide(input).key);

    expect([...keys].sort()).toEqual(["awaiting-stock", "finalize", "finalized", "no-orders", "pick-order", "scan-first", "scan-more"]);
  });
});
