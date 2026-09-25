import { describe, expect, it } from "vitest";
import { pickInboundNextStep, type InboundNextStepInput } from "./inbound-next-step";

const base: InboundNextStepInput = {
  pendingDocuments: [],
  awaitingLineCount: 0,
  needsCheckScanCount: 0,
  hasAnyDocument: false,
  hasAnyScan: false,
};

describe("pickInboundNextStep", () => {
  it("명세서도 스캔도 없으면 명세서 올리기, 명세서 없이 스캔하는 길도 함께 안내한다", () => {
    const step = pickInboundNextStep(base);

    expect(step.key).toBe("upload");
    expect(step.secondary?.href).toBe("#inbound-scan-form");
  });

  it("대기 명세서에 안 들어온 품목이 있으면 스캔을 안내한다", () => {
    const step = pickInboundNextStep({
      ...base,
      hasAnyDocument: true,
      pendingDocuments: [{ id: "d1", completeLines: 0, totalLines: 3 }],
      awaitingLineCount: 3,
    });

    expect(step.key).toBe("scan");
    expect(step.detail).toContain("3");
  });

  it("다 찍었는데 줄이 덜 맞으면 가장 오래된 미완료 명세서의 대조 화면으로 보낸다", () => {
    const step = pickInboundNextStep({
      ...base,
      hasAnyDocument: true,
      hasAnyScan: true,
      pendingDocuments: [
        { id: "old", completeLines: 2, totalLines: 2 },
        { id: "mid", completeLines: 1, totalLines: 3 },
        { id: "new", completeLines: 0, totalLines: 1 },
      ],
    });

    expect(step.key).toBe("reconcile");
    expect(step.href).toBe("/dashboard/inbound/documents/mid");
    expect(step.detail).toContain("3");
  });

  it("모든 줄이 맞으면 마감을 안내한다", () => {
    const step = pickInboundNextStep({
      ...base,
      hasAnyDocument: true,
      hasAnyScan: true,
      pendingDocuments: [{ id: "d1", completeLines: 2, totalLines: 2 }],
    });

    expect(step.key).toBe("close");
    expect(step.href).toBe("/dashboard/inbound/documents/d1");
  });

  it("스캔이 남아 있으면 마감보다 스캔이 먼저다", () => {
    const step = pickInboundNextStep({
      ...base,
      hasAnyDocument: true,
      pendingDocuments: [{ id: "d1", completeLines: 1, totalLines: 2 }],
      awaitingLineCount: 1,
    });

    expect(step.key).toBe("scan");
  });

  it("대기 명세서가 없고 확인 필요한 박스가 있으면 그것을 안내한다", () => {
    const step = pickInboundNextStep({ ...base, hasAnyScan: true, needsCheckScanCount: 2 });

    expect(step.key).toBe("review-scans");
    expect(step.detail).toContain("2");
  });

  it("명세서 없이 스캔만 한 경우(문제 없음)에도 막히지 않고 스캔을 안내한다", () => {
    const step = pickInboundNextStep({ ...base, hasAnyScan: true });

    expect(step.key).toBe("keep-scanning");
    expect(step.href).toBe("#inbound-scan-form");
  });

  it("취소된 명세서만 있는 경우 스캔 기록도 없으면 명세서 올리기다", () => {
    const step = pickInboundNextStep({ ...base, hasAnyDocument: false, hasAnyScan: false });

    expect(step.key).toBe("upload");
  });
});
