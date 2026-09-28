import { describe, expect, it } from "vitest";
import { needsAttention, pickFieldNextStep, type InboundNextStepInput } from "./inbound-next-step";

const base: InboundNextStepInput = {
  needsCheckScanCount: 0,
};

describe("pickFieldNextStep — 입고 스캔(현장) 화면 카드", () => {
  it("확인할 것이 없으면 바로 스캔을 안내한다", () => {
    const step = pickFieldNextStep(base);

    expect(step.key).toBe("field-start");
    expect(step.who).toBe("현장");
    expect(step.href).toBe("#inbound-scan-form");
  });

  it("확인 필요 박스가 있으면 그 박스부터 처리하라고 안내한다", () => {
    const step = pickFieldNextStep({ needsCheckScanCount: 2, firstNeedsCheckScanId: "s7" });

    expect(step.key).toBe("field-check");
    expect(step.title).toContain("2개");
    expect(step.buttonLabel).toBe("확인 필요 박스로 가기");
    expect(step.href).toBe("#scan-s7");
  });

  it("확인 필요 박스의 id가 없으면 확인 필요 목록 자리로 보낸다", () => {
    const step = pickFieldNextStep({ needsCheckScanCount: 1, firstNeedsCheckScanId: null });

    expect(step.href).toBe("#inbound-unresolved");
  });

  it("현장 카드의 링크는 전부 같은 화면 안이다(다른 화면으로 보내지 않는다)", () => {
    const steps = [pickFieldNextStep(base), pickFieldNextStep({ needsCheckScanCount: 2, firstNeedsCheckScanId: "a" })];

    steps.forEach((step) => {
      [step.href, ...step.secondaries.map((link) => link.href)].forEach((href) => {
        expect(href.startsWith("#")).toBe(true);
      });
    });
  });
});

describe("needsAttention — 강조 카드 판정", () => {
  it("확인 필요 박스 카드는 강조한다", () => {
    expect(needsAttention(pickFieldNextStep({ needsCheckScanCount: 1, firstNeedsCheckScanId: "a" }))).toBe(true);
  });

  it("스캔 시작 카드는 강조하지 않는다", () => {
    expect(needsAttention(pickFieldNextStep(base))).toBe(false);
  });
});
