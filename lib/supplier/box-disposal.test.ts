import { describe, expect, it } from "vitest";
import { previewDisposal } from "./box-disposal";

describe("previewDisposal", () => {
  it("일부 폐기: 남는 양과 손실 금액(중량 × 매입단가, 원 단위 반올림)", () => {
    expect(previewDisposal(10, 40000, 2.5, "EXPIRED", "")).toEqual({ after: 7.5, lossAmount: 100000, error: null });
    expect(previewDisposal(10, 33333, 0.001, "DAMAGE", "")).toMatchObject({ lossAmount: 33 });
  });

  it("전량 폐기는 남는 양 0", () => {
    expect(previewDisposal(4, 1000, 4, "SPOILED", "")).toMatchObject({ after: 0, lossAmount: 4000, error: null });
  });

  it("매입단가를 모르면 금액은 비고 폐기는 된다", () => {
    expect(previewDisposal(4, null, 1, "DAMAGE", "")).toEqual({ after: 3, lossAmount: null, error: null });
  });

  it("0·음수·빈 값·남은 양 초과·소수 4자리는 막는다", () => {
    for (const weight of [null, 0, -1, Number.NaN, 4.001, 1.0001]) {
      expect(previewDisposal(4, 1000, weight, "DAMAGE", "").error).not.toBeNull();
    }
  });

  it("기타 사유는 메모 2자 이상 필요", () => {
    expect(previewDisposal(4, 1000, 1, "OTHER", " ").error).not.toBeNull();
    expect(previewDisposal(4, 1000, 1, "OTHER", "쥐 피해").error).toBeNull();
  });
});
