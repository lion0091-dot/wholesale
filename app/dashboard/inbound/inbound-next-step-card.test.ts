import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("./document-actions", () => ({ closeInboundDocumentAction: async () => ({ success: true }) }));

import { InboundNextStepCard } from "./inbound-next-step-card";
import { needsAttention, pickFieldNextStep, pickInboundNextStep, type InboundNextStepInput } from "@/lib/livestock/inbound-next-step";

const base: InboundNextStepInput = { pendingDocuments: [], remainingBoxCount: 0, needsCheckScanCount: 0 };
const render = (input: InboundNextStepInput, who: "field" | "office") =>
  renderToStaticMarkup(createElement(InboundNextStepCard, { step: who === "field" ? pickFieldNextStep(input) : pickInboundNextStep(input) }));

describe("지금 할 일 카드 — 진짜 할 일만 '여기를 보세요'로 강조한다", () => {
  it("확인 필요 박스 처리는 반전(어두운 바탕·노란 버튼) 강조 카드로, '여기를 보세요' 표시가 붙는다", () => {
    const html = render({ ...base, needsCheckScanCount: 2, firstNeedsCheckScanId: "s1" }, "field");

    expect(html).toContain("▶ 여기를 보세요");
    expect(html).toContain("inbound-attention");
    expect(html).toContain("#0f172a");
    expect(html).toContain("#facc15");
    expect(html).toContain("확인이 필요한 박스 2개를 먼저 처리하세요");
  });

  it("평소 시작 상태(스캔 시작)·기다림 카드는 강조하지 않고 작게 그린다", () => {
    const start = render(base, "field");
    const waiting = render({ ...base, pendingDocuments: [{ id: "d", completeLines: 0, totalLines: 2 }], remainingBoxCount: 2 }, "office");

    for (const html of [start, waiting]) {
      expect(html).not.toContain("여기를 보세요");
      expect(html).not.toContain("inbound-attention");
    }
  });

  it("사무실의 전표 대조·마감·확인 마감은 강조하고, 전표 올리기·현장 스캔 중은 강조하지 않는다", () => {
    const reconcile = pickInboundNextStep({ ...base, pendingDocuments: [{ id: "d", completeLines: 0, totalLines: 2 }], unlinkedOpenBoxes: [{ scanId: "s", documentId: "d" }] });
    const finished = pickInboundNextStep({ ...base, pendingDocuments: [{ id: "d", completeLines: 1, totalLines: 2, scanFinished: true }], remainingBoxCount: 1 });
    const upload = pickInboundNextStep(base);
    const scanning = pickInboundNextStep({ ...base, pendingDocuments: [{ id: "d", completeLines: 0, totalLines: 2 }], remainingBoxCount: 2 });

    expect(needsAttention(reconcile)).toBe(true);
    expect(needsAttention(finished)).toBe(true);
    expect(needsAttention(upload)).toBe(false);
    expect(needsAttention(scanning)).toBe(false);
  });

  it("누를 수 없는 카드(기다림 버튼)는 어떤 경우에도 강조하지 않는다", () => {
    expect(needsAttention({ key: "scan-finished", buttonDisabled: true })).toBe(false);
  });
});
