import { describe, expect, it } from "vitest";
import { pickInboundNextStep, type InboundNextStepInput } from "./inbound-next-step";

const base: InboundNextStepInput = {
  pendingDocuments: [],
  awaitingLineCount: 0,
  needsCheckScanCount: 0,
};

describe("pickInboundNextStep", () => {
  it("대기 명세서가 없으면 명세서 올리기, 명세서 없이 스캔하는 길도 함께 안내한다", () => {
    const step = pickInboundNextStep(base);

    expect(step.key).toBe("upload");
    expect(step.secondaries.map((link) => link.href)).toEqual(["#inbound-scan-form"]);
  });

  it("대기 명세서에 안 들어온 품목이 있으면 스캔을 안내한다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 0, totalLines: 3 }],
      awaitingLineCount: 3,
    });

    expect(step.key).toBe("scan");
    expect(step.detail).toContain("3");
  });

  it("다 찍었는데 줄이 덜 맞으면 가장 오래된 미완료 명세서의 대조 화면으로 보낸다", () => {
    const step = pickInboundNextStep({
      ...base,
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
      pendingDocuments: [{ id: "d1", completeLines: 2, totalLines: 2 }],
    });

    expect(step.key).toBe("close");
    expect(step.href).toBe("/dashboard/inbound/documents/d1");
  });

  it("스캔이 남아 있으면 마감보다 스캔이 먼저다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 1, totalLines: 2 }],
      awaitingLineCount: 1,
    });

    expect(step.key).toBe("scan");
  });

  it("확인 필요한 박스가 남아 있어도 큰 버튼은 명세서 올리기이고, 그 박스는 작은 링크로 바로 이동한다", () => {
    const step = pickInboundNextStep({ ...base, needsCheckScanCount: 2, firstNeedsCheckScanId: "abc" });

    expect(step.key).toBe("upload");
    expect(step.href).toBe("#inbound-documents");
    expect(step.secondaries).toContainEqual({ label: "확인이 필요한 박스 2개 보기", href: "#scan-abc" });
  });

  it("대기 명세서가 있으면 확인 필요 박스가 있어도 명세서 흐름이 먼저다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 0, totalLines: 1 }],
      awaitingLineCount: 1,
      needsCheckScanCount: 2,
    });

    expect(step.key).toBe("scan");
    expect(step.secondaries).toEqual([]);
  });
});
