/**
 * 안내 카드 상태 표 — 카드가 가질 수 있는 모든 입력 조합을 돌려 "따라가기가 끊기지 않는다"를 규칙으로 검사한다.
 * 규칙이 깨지면(눌러도 갈 곳이 없는 버튼, 강조 남발) 여기서 실패한다.
 */
import { describe, expect, it } from "vitest";
import { INBOUND_ANCHORS, needsAttention, pickFieldNextStep, type InboundNextStepInput } from "./inbound-next-step";

function allInputs(): Array<{ name: string; input: InboundNextStepInput }> {
  const list: Array<{ name: string; input: InboundNextStepInput }> = [];

  for (const needsCheck of [0, 2]) {
    for (const hasFirstId of [true, false]) {
      list.push({
        name: `확인필요=${needsCheck} 첫박스id있음=${hasFirstId}`,
        input: {
          needsCheckScanCount: needsCheck,
          firstNeedsCheckScanId: needsCheck && hasFirstId ? "s1" : null,
        },
      });
    }
  }

  return list;
}

const allLinks = (step: ReturnType<typeof pickFieldNextStep>) => [step.href, ...step.secondaries.map((link) => link.href)];

describe("현장 카드 — 모든 상태에서 따라가기가 끊기지 않는다", () => {
  const cases = allInputs();

  it("조합이 충분히 많다(표가 비어 있어 통과하는 일이 없게)", () => {
    expect(cases.length).toBe(4);
  });

  it("모든 상태에서 제목·버튼 이름이 있고, 모든 링크가 같은 화면 안 앵커(#)다", () => {
    for (const { name, input } of cases) {
      const step = pickFieldNextStep(input);

      expect(step.title.length, name).toBeGreaterThan(0);
      expect(step.buttonLabel.length, name).toBeGreaterThan(0);

      for (const href of allLinks(step)) expect(href.startsWith("#"), `${name} → ${href}`).toBe(true);
    }
  });

  it("현장 카드는 누를 수 없는 버튼을 쓰지 않는다(현장이 막히지 않게)", () => {
    for (const { name, input } of cases) expect(pickFieldNextStep(input).buttonDisabled, name).toBeUndefined();
  });

  it("확인 필요 박스가 있으면 '지금 할 일'은 그것 하나이고, 버튼은 그 박스 자리로 간다", () => {
    for (const { name, input } of cases.filter((item) => item.input.needsCheckScanCount > 0)) {
      const step = pickFieldNextStep(input);

      expect(step.key, name).toBe("field-check");
      expect(step.title, name).toContain(String(input.needsCheckScanCount));
      expect(step.href, name).toBe(input.firstNeedsCheckScanId ? `#scan-${input.firstNeedsCheckScanId}` : INBOUND_ANCHORS.unresolved);
      // 새 박스를 먼저 찍고 싶을 때의 길은 작은 링크로 남겨 둔다(막지는 않는다).
      expect(step.secondaries.map((link) => link.href), name).toContain(INBOUND_ANCHORS.scanForm);
    }
  });

  it("확인 필요 박스가 없으면 그 카드는 절대 나오지 않는다", () => {
    for (const { name, input } of cases.filter((item) => item.input.needsCheckScanCount === 0)) {
      expect(pickFieldNextStep(input).key, name).not.toBe("field-check");
    }
  });
});

describe("강조('여기를 보세요') 규칙 — 눌러서 할 일이 있는 카드에만 붙는다", () => {
  const cases = allInputs();

  it("확인 필요 박스가 있으면 항상 강조, 없으면 강조하지 않는다", () => {
    for (const { name, input } of cases) {
      expect(needsAttention(pickFieldNextStep(input)), name).toBe(input.needsCheckScanCount > 0);
    }
  });
});
