import { describe, expect, it } from "vitest";
import { pickFieldNextStep, pickInboundNextStep, type InboundNextStepInput } from "./inbound-next-step";

const base: InboundNextStepInput = {
  pendingDocuments: [],
  remainingBoxCount: 0,
  needsCheckScanCount: 0,
};

describe("pickInboundNextStep", () => {
  it("대기 전표가 없으면 전표 올리기, 전표 없이 스캔하는 길도 함께 안내한다", () => {
    const step = pickInboundNextStep(base);

    expect(step.key).toBe("upload");
    expect(step.secondaries.map((link) => link.href)).toEqual(["/dashboard/inbound#inbound-scan-form"]);
  });

  it("대기 전표에 안 들어온 품목이 있으면 스캔을 안내한다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 0, totalLines: 3 }],
      remainingBoxCount: 4,
    });

    expect(step.key).toBe("scan");
    expect(step.detail).toContain("4");
  });

  it("다 찍었는데 줄이 덜 맞으면 가장 오래된 미완료 전표의 대조 화면으로 보낸다", () => {
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
    expect(step.title).toBe("전부 입고 완료되었습니다");
    expect(step.buttonLabel).toBe("마감하기");
    expect(step.closeDocumentId).toBe("d1");
    expect(step.href).toBe("/dashboard/inbound/documents/d1");
  });

  it("전부 도착했어도 상품이 안 정해진 박스가 있으면 '입고 완료'라고 하지 않고 먼저 확인시킨다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [
        { id: "d1", completeLines: 2, totalLines: 2, unresolvedBoxes: 1, firstUnresolvedScanId: "s9" },
      ],
    });

    expect(step.title).toBe("전부 도착했습니다");
    expect(step.detail).toContain("재고에 아직 안 들어갔습니다");
    expect(step.buttonLabel).toBe("상품 지정하러 가기");
    expect(step.href).toBe("/dashboard/inbound/documents/d1#box-s9");
    expect(step.secondaries[0].href).toBe("/dashboard/inbound/documents/d1#close");
  });

  it("줄이 다 안 맞아도 남은 박스가 있으면(수량 2에 1박스만 옴) 맞춰 보기가 아니라 스캔을 안내한다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 2, totalLines: 3 }],
      remainingBoxCount: 1,
    });

    expect(step.key).toBe("scan");
  });

  it("현장이 스캔 종료를 표시했으면 남은 박스가 있어도 사무실 카드는 확인·마감하기다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", scanFinished: true, completeLines: 1, totalLines: 2 }],
      remainingBoxCount: 1,
    });

    expect(step.key).toBe("scan-finished");
    expect(step.buttonLabel).toBe("확인·마감하기");
    expect(step.buttonDisabled).toBeUndefined();
    expect(step.href).toBe("/dashboard/inbound/documents/d1#close");
  });

  it("전표가 둘 이상이고 하나라도 스캔 중이면 아직 스캔 단계다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [
        { id: "d1", scanFinished: true, completeLines: 1, totalLines: 2 },
        { id: "d2", scanFinished: false, completeLines: 0, totalLines: 1 },
      ],
      remainingBoxCount: 2,
    });

    expect(step.key).toBe("scan");
  });

  it("스캔이 남아 있으면 마감보다 스캔이 먼저다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 1, totalLines: 2 }],
      remainingBoxCount: 1,
    });

    expect(step.key).toBe("scan");
  });

  it("확인 필요한 박스가 남아 있어도 큰 버튼은 전표 올리기이고, 그 박스는 작은 링크로 바로 이동한다", () => {
    const step = pickInboundNextStep({ ...base, needsCheckScanCount: 2, firstNeedsCheckScanId: "abc" });

    expect(step.key).toBe("upload");
    expect(step.href).toBe("#inbound-documents");
    expect(step.secondaries).toContainEqual({ label: "확인이 필요한 박스 2개 보기", href: "/dashboard/inbound#scan-abc" });
  });

  it("대기 전표가 있으면 확인 필요 박스가 있어도 전표 흐름이 먼저다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 0, totalLines: 1 }],
      remainingBoxCount: 1,
      needsCheckScanCount: 2,
    });

    expect(step.key).toBe("scan");
    expect(step.secondaries.map((link) => link.label)[0]).toBe("현장: 스캔 화면으로 이동");
  });

  it("스캔 단계에서는 사무실에게 기다리라고, 확인·마감 단계에서는 현장에게 스캔이 끝났다고 알린다", () => {
    const scanning = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 0, totalLines: 2 }],
      remainingBoxCount: 2,
    });
    const closing = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 2, totalLines: 2 }],
    });

    expect(scanning.who).toBe("사무실");
    expect(scanning.buttonLabel).toBe("스캔 중 대기");
    expect(scanning.buttonDisabled).toBe(true);
    expect(scanning.detail).toContain("기다려 주세요");
    expect(scanning.secondaries[0].href).toBe("/dashboard/inbound#inbound-scan-form");
    expect(scanning.secondaries[1].href).toBe("/dashboard/inbound/documents/d1#close");
    expect(closing.waitNote?.who).toBe("현장");
    expect(pickInboundNextStep(base).waitNote).toBeNull();
  });

  it("스캔 종료·스캔 중 카드는 안 온 박스가 남은 전표로 보낸다(가장 오래된 전표가 아니라)", () => {
    const docs = [
      { id: "old", scanFinished: true, completeLines: 2, totalLines: 2 },
      { id: "new", scanFinished: true, completeLines: 0, totalLines: 2 },
    ];
    const finished = pickInboundNextStep({ ...base, pendingDocuments: docs, remainingBoxCount: 2 });
    const scanning = pickInboundNextStep({
      ...base,
      pendingDocuments: docs.map((doc) => ({ ...doc, scanFinished: false })),
      remainingBoxCount: 2,
    });

    expect(finished.key).toBe("scan-finished");
    expect(finished.href).toBe("/dashboard/inbound/documents/new#close");
    expect(scanning.secondaries[1].href).toBe("/dashboard/inbound/documents/new#close");
  });

  it("상품 미지정 박스가 있는 전표로 '그래도 마감하러 가기'를 보낸다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [
        { id: "clean", completeLines: 1, totalLines: 1 },
        { id: "dirty", completeLines: 1, totalLines: 1, unresolvedBoxes: 1, firstUnresolvedScanId: "s1" },
      ],
    });

    expect(step.href).toBe("/dashboard/inbound/documents/dirty#box-s1");
    expect(step.secondaries[0].href).toBe("/dashboard/inbound/documents/dirty#close");
  });
});

describe("pickInboundNextStep — 따라가기 끊김 방지", () => {
  it("스캔 대기 카드는 물건이 안 오는 경우의 탈출구를 본문에서 직접 알려 준다", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 0, totalLines: 2 }],
      remainingBoxCount: 2,
    });

    expect(step.detail).toContain("확인·마감하기");
  });

  it("상품 지정 버튼은 대조 화면의 그 박스로 바로 데려간다(다른 화면에 갔다 돌아올 필요 없음)", () => {
    const step = pickInboundNextStep({
      ...base,
      pendingDocuments: [
        { id: "d1", completeLines: 1, totalLines: 1, unresolvedBoxes: 1, firstUnresolvedScanId: "s1" },
      ],
    });

    expect(step.href).toBe("/dashboard/inbound/documents/d1#box-s1");
  });
});

describe("pickFieldNextStep — 입고 스캔(현장) 화면 카드", () => {
  it("전표가 없으면 바로 스캔을 안내한다", () => {
    const step = pickFieldNextStep(base);

    expect(step.key).toBe("field-start");
    expect(step.who).toBe("현장");
    expect(step.href).toBe("#inbound-scan-form");
  });

  it("전표 기준으로 남은 박스가 있으면 몇 개 더 찍을지 알려 준다", () => {
    const step = pickFieldNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 0, totalLines: 3 }],
      remainingBoxCount: 4,
    });

    expect(step.key).toBe("field-scan");
    expect(step.title).toContain("4");
  });

  it("현장이 스캔 종료를 알렸으면 사무실이 확인 중이라고 안내한다", () => {
    const step = pickFieldNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", scanFinished: true, completeLines: 1, totalLines: 2 }],
      remainingBoxCount: 1,
    });

    expect(step.key).toBe("field-done");
    expect(step.waitNote?.who).toBe("사무실");
  });

  it("다 찍었는데 상품 미지정 박스가 있으면 그 박스로 보낸다", () => {
    const step = pickFieldNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 2, totalLines: 2 }],
      needsCheckScanCount: 1,
      firstNeedsCheckScanId: "s7",
    });

    expect(step.buttonLabel).toBe("상품 지정하러 가기");
    expect(step.href).toBe("#scan-s7");
  });

  it("다 찍었고 확인할 박스도 없으면 사무실이 마감한다고 알린다", () => {
    const step = pickFieldNextStep({
      ...base,
      pendingDocuments: [{ id: "d1", completeLines: 2, totalLines: 2 }],
    });

    expect(step.key).toBe("field-done");
    expect(step.detail).toContain("사무실");
  });

  it("현장 카드의 링크는 전부 같은 화면 안이다(전표 화면으로 보내지 않는다)", () => {
    const steps = [
      pickFieldNextStep({ ...base, needsCheckScanCount: 2, firstNeedsCheckScanId: "a" }),
      pickFieldNextStep({ ...base, pendingDocuments: [{ id: "d", completeLines: 0, totalLines: 1 }], remainingBoxCount: 1 }),
      pickFieldNextStep({ ...base, pendingDocuments: [{ id: "d", completeLines: 1, totalLines: 1 }] }),
    ];

    steps.forEach((step) => {
      [step.href, ...step.secondaries.map((link) => link.href)].forEach((href) => {
        expect(href.startsWith("#")).toBe(true);
      });
    });
  });
});

describe("여러 장 전표·현장 종료 안내", () => {
  it("대기 전표가 둘 이상이면 카드 문장 앞에 공급처 이름을 붙인다", () => {
    const step = pickInboundNextStep({
      pendingDocuments: [
        { id: "a", supplierName: "대성축산", completeLines: 1, totalLines: 2 },
        { id: "b", supplierName: "한우촌", completeLines: 2, totalLines: 2 },
      ],
      remainingBoxCount: 0,
      needsCheckScanCount: 0,
    });

    expect(step.detail).toContain("[대성축산]");
  });

  it("전표가 하나면 공급처 이름은 붙이지 않는다", () => {
    const step = pickInboundNextStep({
      pendingDocuments: [{ id: "a", supplierName: "대성축산", completeLines: 1, totalLines: 2 }],
      remainingBoxCount: 0,
      needsCheckScanCount: 0,
    });

    expect(step.detail).not.toContain("[");
  });

  it("현장 카드는 '남았으면 스캔 종료' 버튼 자리로 바로 데려간다", () => {
    const step = pickFieldNextStep({
      pendingDocuments: [{ id: "a", completeLines: 0, totalLines: 2 }],
      remainingBoxCount: 2,
      needsCheckScanCount: 0,
    });

    expect(step.secondaries.map((link) => link.href)).toContain("#inbound-scan-finish");
  });
});
