import { describe, expect, it } from "vitest";
import {
  INBOUND_WEIGHT_TOLERANCE,
  calcPurchaseAmount,
  evaluateWeightVariance,
  formatVarianceRatio,
  formatVarianceWeight,
} from "@/lib/livestock/weight-variance";

describe("evaluateWeightVariance", () => {
  it("표기중량이 없으면 판정하지 않는다", () => {
    expect(evaluateWeightVariance(null, 10)).toBeNull();
    expect(evaluateWeightVariance(undefined, 10)).toBeNull();
    expect(evaluateWeightVariance(0, 10)).toBeNull();
  });

  it("실중량이 없으면 판정하지 않는다", () => {
    expect(evaluateWeightVariance(10, null)).toBeNull();
  });

  it("허용 오차(±2%) 이내면 exceeded=false", () => {
    const result = evaluateWeightVariance(10, 9.85); // -1.5%

    expect(result).not.toBeNull();
    expect(result!.exceeded).toBe(false);
  });

  it("허용 오차를 넘으면 exceeded=true", () => {
    const result = evaluateWeightVariance(10, 9.5); // -5%

    expect(result!.exceeded).toBe(true);
    expect(result!.ratio).toBeCloseTo(-0.05, 5);
  });

  it("허용 오차 기준값 자체는 2%", () => {
    expect(INBOUND_WEIGHT_TOLERANCE).toBe(0.02);
  });
});

describe("formatVarianceRatio / formatVarianceWeight", () => {
  it("양수는 +부호를 붙인다", () => {
    expect(formatVarianceRatio(0.015)).toBe("+1.5%");
    expect(formatVarianceWeight(0.2)).toBe("+0.200kg");
  });

  it("음수는 부호를 그대로 둔다", () => {
    expect(formatVarianceRatio(-0.015)).toBe("-1.5%");
    expect(formatVarianceWeight(-0.2)).toBe("-0.200kg");
  });

  it("0은 부호 없이 표시한다", () => {
    expect(formatVarianceWeight(0)).toBe("0.000kg");
  });
});

describe("calcPurchaseAmount", () => {
  it("실중량 × 단가를 원 단위로 반올림한다", () => {
    expect(calcPurchaseAmount(9.85, 32000)).toBe(315200);
  });

  it("값이 없으면 null", () => {
    expect(calcPurchaseAmount(null, 32000)).toBeNull();
    expect(calcPurchaseAmount(9.85, null)).toBeNull();
    expect(calcPurchaseAmount(NaN, 32000)).toBeNull();
  });
});
