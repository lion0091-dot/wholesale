import { describe, expect, it } from "vitest";
import { checkMovementEvidence, movementLabel, previewRepair, type MismatchRow, type MovementRow } from "./stock-repair";

const box = (over: Partial<MismatchRow> = {}): MismatchRow => ({
  kind: "box",
  targetId: "b1",
  label: "0999…01 · 한우 등심",
  unit: "kg",
  currentValue: 9,
  ledgerValue: 10,
  diff: -1,
  boxWeight: 10,
  unitPrice: 40000,
  ...over,
});

const product = (over: Partial<MismatchRow> = {}): MismatchRow => ({
  kind: "product",
  targetId: "p1",
  label: "한우 등심",
  unit: "kg",
  currentValue: 11,
  ledgerValue: 10,
  diff: 1,
  boxWeight: null,
  unitPrice: null,
  ...over,
});

describe("previewRepair — 장부 기준", () => {
  it("박스 잔량을 장부 값으로 되돌리고, 늘어난 만큼 재고 평가금액이 늘어난다", () => {
    expect(previewRepair(box(), "LEDGER", null)).toEqual({ after: 10, ledgerChange: 0, valuationChange: 40000, error: null });
  });

  it("상품은 금액 영향을 계산하지 않는다(어느 박스인지 모른다)", () => {
    expect(previewRepair(product(), "LEDGER", null)).toEqual({ after: 10, ledgerChange: 0, valuationChange: null, error: null });
  });

  it("매입단가를 모르는 박스도 금액만 빠지고 보정은 된다", () => {
    expect(previewRepair(box({ unitPrice: null }), "LEDGER", null)).toMatchObject({ after: 10, valuationChange: null, error: null });
  });

  it("장부 값이 박스 입고 중량을 벗어나면 장부 기준은 못 쓴다", () => {
    const preview = previewRepair(box({ ledgerValue: 12 }), "LEDGER", null);

    expect(preview.after).toBeNull();
    expect(preview.error).toContain("실물 기준");
  });
});

describe("previewRepair — 실물 기준", () => {
  it("실사 수량으로 맞추면 장부에 그 차이만큼 보정 기록이 쌓이고, 줄어든 만큼 평가금액이 준다", () => {
    expect(previewRepair(box(), "ACTUAL", 7.5)).toEqual({ after: 7.5, ledgerChange: -2.5, valuationChange: -60000, error: null });
  });

  it("그램(0.001) 단위로 계산한다", () => {
    expect(previewRepair(box({ currentValue: 6.669, ledgerValue: 6.668, boxWeight: 10.001 }), "ACTUAL", 6.668)).toMatchObject({
      after: 6.668,
      ledgerChange: 0,
      valuationChange: Math.round(-0.001 * 40000),
    });
  });

  it("수량을 안 넣거나 음수면 막는다", () => {
    expect(previewRepair(box(), "ACTUAL", null).error).toContain("입력");
    expect(previewRepair(box(), "ACTUAL", -1).error).toContain("0보다");
  });

  it("박스는 입고 중량보다 많이 못 맞춘다", () => {
    const preview = previewRepair(box(), "ACTUAL", 11);

    expect(preview.after).toBeNull();
    expect(preview.error).toContain("10kg");
  });

  it("상품은 실물 수량을 그대로 받는다(상한 없음, 금액 영향 없음)", () => {
    expect(previewRepair(product(), "ACTUAL", 12)).toEqual({ after: 12, ledgerChange: 2, valuationChange: null, error: null });
  });
});

const move = (eventType: string, qtyDelta: number): MovementRow => ({
  createdAt: "2026-10-02T00:00:00Z",
  eventType,
  qtyDelta,
  sourceType: "inbound_scan",
  orderNumber: null,
  reason: null,
  actorName: null,
  boxTraceNo: null,
});

describe("checkMovementEvidence — 장부가 입출고 기록과 맞는지", () => {
  it("입고 10 − 출고 0.6 = 장부 9.4이고 입고 중량도 10이면 경고가 없다", () => {
    const evidence = checkMovementEvidence(box({ currentValue: 9, ledgerValue: 9.4, boxWeight: 10 }), [move("INBOUND", 10), move("ORDER_OUT", -0.6)]);

    expect(evidence.warnings).toEqual([]);
    expect(evidence.sum).toBe(9.4);
  });

  it("기록을 더한 값이 장부 값과 다르면 기록이 빠졌을 수 있다고 경고한다", () => {
    const evidence = checkMovementEvidence(box({ ledgerValue: 9.4, boxWeight: 10 }), [move("INBOUND", 10), move("ORDER_OUT", -0.5)]);

    expect(evidence.warnings.join(" ")).toContain("기록이 일부 빠져");
  });

  it("장부의 입고 기록이 박스 입고 중량과 다르면 장부 자체를 먼저 확인하라고 경고한다", () => {
    const evidence = checkMovementEvidence(box({ ledgerValue: 8, boxWeight: 10 }), [move("INBOUND", 8)]);

    expect(evidence.warnings.join(" ")).toContain("입고 중량");
  });

  it("기록이 100건이면 잘렸으니 합계 대조를 하지 않는다", () => {
    const many = Array.from({ length: 100 }, () => move("ORDER_OUT", -0.1));
    const evidence = checkMovementEvidence(box({ ledgerValue: 5 }), many);

    expect(evidence.truncated).toBe(true);
    expect(evidence.warnings).toEqual([]);
  });

  it("상품은 입고 중량 대조 없이 합계만 본다", () => {
    expect(checkMovementEvidence(product({ ledgerValue: 10 }), [move("INBOUND", 10)]).warnings).toEqual([]);
    expect(checkMovementEvidence(product({ ledgerValue: 10 }), [move("INBOUND", 9)]).warnings.length).toBe(1);
  });

  it("이벤트 이름을 알아볼 수 있는 말로 바꾼다", () => {
    expect(movementLabel("OUTBOUND_UNASSIGN")).toContain("정정");
    expect(movementLabel("ADJUSTMENT")).toContain("보정");
    expect(movementLabel("UNKNOWN_X")).toBe("UNKNOWN_X");
  });
});
