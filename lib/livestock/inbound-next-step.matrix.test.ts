/**
 * 안내 카드 상태 표 — 카드가 가질 수 있는 모든 입력 조합을 돌려 "따라가기가 끊기지 않는다"를 규칙으로 검사한다.
 * 규칙이 깨지면(눌러도 갈 곳이 없는 버튼, 기다리라면서 탈출구가 없는 카드, 이미 온 박스를 못 알리는 카드) 여기서 실패한다.
 */
import { describe, expect, it } from "vitest";
import {
  INBOUND_ANCHORS,
  pickFieldNextStep,
  pickInboundNextStep,
  type InboundNextStep,
  type InboundNextStepInput,
} from "./inbound-next-step";

type Doc = InboundNextStepInput["pendingDocuments"][number];

const docs: Record<string, Doc[]> = {
  없음: [],
  덜맞음: [{ id: "d1", completeLines: 0, totalLines: 3 }],
  줄다맞음: [{ id: "d1", completeLines: 3, totalLines: 3 }],
  상품미지정: [{ id: "d1", completeLines: 3, totalLines: 3, unresolvedBoxes: 2, firstUnresolvedScanId: "s9" }],
  스캔종료: [{ id: "d1", completeLines: 1, totalLines: 3, scanFinished: true }],
  두장: [
    { id: "d1", supplierName: "가", completeLines: 0, totalLines: 2 },
    { id: "d2", supplierName: "나", completeLines: 2, totalLines: 2 },
  ],
};

function allInputs(): Array<{ name: string; input: InboundNextStepInput }> {
  const list: Array<{ name: string; input: InboundNextStepInput }> = [];

  for (const [docName, pendingDocuments] of Object.entries(docs)) {
    for (const remaining of [0, 3]) {
      for (const weightLines of [0, 1]) {
        for (const needsCheck of [0, 2]) {
          for (const late of [0, 1]) {
            for (const unlinked of [0, 1]) {
              list.push({
                name: `전표=${docName} 남은=${remaining} 무게줄=${weightLines} 확인필요=${needsCheck} 뒤늦게=${late} 안이어짐=${unlinked}`,
                input: {
                  pendingDocuments,
                  remainingBoxCount: remaining,
                  remainingWeightLines: Math.min(weightLines, remaining),
                  needsCheckScanCount: needsCheck,
                  firstNeedsCheckScanId: needsCheck ? "s1" : null,
                  lateBoxes: late ? [{ scanId: "s2", documentId: "closed-doc" }] : [],
                  unlinkedOpenBoxes: unlinked ? [{ scanId: "s3", documentId: "d1" }] : [],
                },
              });
            }
          }
        }
      }
    }
  }

  return list;
}

const allLinks = (step: InboundNextStep) => [step.href, ...step.secondaries.map((link) => link.href)];
const validHref = (href: string) => href.startsWith("#") || href.startsWith("/dashboard/");

describe("사무실 카드 — 모든 상태에서 따라가기가 끊기지 않는다", () => {
  const cases = allInputs();

  it("조합이 충분히 많다(표가 비어 있어 통과하는 일이 없게)", () => {
    expect(cases.length).toBe(192);
  });

  it("모든 상태에서 제목·문구·버튼 이름이 있고, 모든 링크가 화면 안 앵커나 대시보드 경로다", () => {
    for (const { name, input } of cases) {
      const step = pickInboundNextStep(input);

      expect(step.title.length, name).toBeGreaterThan(0);
      expect((step.detail ?? "").length + step.buttonLabel.length, name).toBeGreaterThan(0);

      for (const href of allLinks(step)) expect(validHref(href), `${name} → ${href}`).toBe(true);
    }
  });

  it("누를 수 없는 '기다림' 버튼은 '스캔 중' 카드 하나뿐이고, 그때는 반드시 눌러서 마감할 탈출구가 함께 있다", () => {
    for (const { name, input } of cases) {
      const step = pickInboundNextStep(input);

      if (!step.buttonDisabled) continue;

      expect(step.key, name).toBe("scan");
      expect(step.secondaries.some((link) => link.href.endsWith("#close")), name).toBe(true);
    }
  });

  it("이미 온 박스가 대기 전표에 안 이어졌으면, 대기 전표가 있는 한 언제나 눌러서 대조 화면으로 가는 카드다", () => {
    for (const { name, input } of cases) {
      if (!input.unlinkedOpenBoxes?.length || input.pendingDocuments.length === 0) continue;

      const step = pickInboundNextStep(input);

      expect(step.key, name).toBe("reconcile");
      expect(step.buttonDisabled, name).toBeUndefined();
      expect(step.href, name).toBe("/dashboard/inbound/documents/d1");
    }
  });

  it("마감된 전표 뒤에 온 박스가 있으면 그 전표로 가는 길이 카드 어딘가에 항상 있다", () => {
    for (const { name, input } of cases) {
      if (!input.lateBoxes?.length) continue;

      const links = allLinks(pickInboundNextStep(input));

      // 대기 전표의 안 이어진 박스 카드가 큰 버튼을 차지하는 경우만 예외 — 그 카드가 먼저 처리할 일이다.
      if (input.unlinkedOpenBoxes?.length && input.pendingDocuments.length > 0) continue;

      expect(links.includes("/dashboard/inbound/documents/closed-doc"), name).toBe(true);
    }
  });

  it("확인이 필요한 박스가 있으면 그 박스로 가는 길이 카드에 남는다(다른 더 급한 카드가 큰 버튼이어도 작은 링크나 큰 버튼 중 하나)", () => {
    for (const { name, input } of cases) {
      if (!input.needsCheckScanCount) continue;

      const step = pickInboundNextStep(input);
      const links = allLinks(step);
      const pointsAtBox = links.some((href) => href.includes("#scan-s1") || href.includes("#box-") || href.endsWith(INBOUND_ANCHORS.history));

      // 대기 전표가 있는 상태에서는 전표 카드가 우선이고, 확인 필요 박스는 대조 화면에서 다룬다.
      if (input.pendingDocuments.length > 0) continue;

      expect(pointsAtBox, name).toBe(true);
    }
  });

  it("'마감하기'(closeDocumentId) 버튼은 그 전표의 대조 화면으로도 갈 수 있다", () => {
    for (const { name, input } of cases) {
      const step = pickInboundNextStep(input);

      if (step.closeDocumentId) expect(step.href, name).toContain(step.closeDocumentId);
    }
  });
});

describe("현장 카드 — 사무실 일을 시키지 않고, 모든 링크가 같은 화면 안이다", () => {
  const cases = allInputs();

  it("모든 상태에서 현장 카드의 큰 버튼과 작은 링크는 같은 화면 앵커(#)이고 사무실 일을 시키지 않는다", () => {
    for (const { name, input } of cases) {
      const step = pickFieldNextStep(input);

      expect(step.who, name).toBe("현장");
      expect(step.title.length, name).toBeGreaterThan(0);

      for (const href of allLinks(step)) expect(href.startsWith("#"), `${name} → ${href}`).toBe(true);

      expect(step.title + (step.detail ?? ""), name).not.toContain("마감하");
    }
  });

  it("현장 카드는 누를 수 없는 버튼을 쓰지 않는다(현장이 막히지 않게)", () => {
    for (const { name, input } of cases) expect(pickFieldNextStep(input).buttonDisabled, name).toBeUndefined();
  });
});
