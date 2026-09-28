import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { InboundNextStepCard } from "./inbound-next-step-card";
import { needsAttention, pickFieldNextStep, type InboundNextStepInput } from "@/lib/livestock/inbound-next-step";

const base: InboundNextStepInput = { needsCheckScanCount: 0 };
const render = (input: InboundNextStepInput) => renderToStaticMarkup(createElement(InboundNextStepCard, { step: pickFieldNextStep(input) }));

describe("지금 할 일 카드 — 진짜 할 일만 '여기를 보세요'로 강조한다", () => {
  it("확인 필요 박스 처리는 반전(어두운 바탕·노란 버튼) 강조 카드로, '여기를 보세요' 표시가 붙는다", () => {
    const html = render({ ...base, needsCheckScanCount: 2, firstNeedsCheckScanId: "s1" });

    expect(html).toContain("▶ 여기를 보세요");
    expect(html).toContain("inbound-attention");
    expect(html).toContain("#0f172a");
    expect(html).toContain("#facc15");
    expect(html).toContain("확인이 필요한 박스 2개를 먼저 처리하세요");
  });

  it("평소 시작 상태(스캔 시작)는 강조하지 않고 작게 그린다", () => {
    const start = render(base);

    expect(start).not.toContain("여기를 보세요");
    expect(start).not.toContain("inbound-attention");
  });

  it("누를 수 없는 카드(기다림 버튼)는 어떤 경우에도 강조하지 않는다", () => {
    expect(needsAttention({ key: "field-check", buttonDisabled: true })).toBe(false);
  });
});
