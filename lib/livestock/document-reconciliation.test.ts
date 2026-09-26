import { describe, expect, it } from "vitest";
import {
  LINE_SUGGESTION_WEIGHT_TOLERANCE_RATIO,
  documentLineExpectedQty,
  documentLineMatchStatus,
  effectiveCountMode,
  lineArrival,
  pickAutoLinkLine,
  pickLineByPart,
  suggestDocumentLinesForScan,
} from "@/lib/livestock/document-reconciliation";

describe("documentLineExpectedQty", () => {
  it("수량이 없으면 1", () => {
    expect(documentLineExpectedQty(null)).toBe(1);
    expect(documentLineExpectedQty(undefined)).toBe(1);
  });

  it("수량을 반올림한다", () => {
    expect(documentLineExpectedQty(2.4)).toBe(2);
    expect(documentLineExpectedQty(2.6)).toBe(3);
  });

  it("0 이하는 최소 1로 올린다", () => {
    expect(documentLineExpectedQty(0)).toBe(1);
    expect(documentLineExpectedQty(-3)).toBe(1);
  });
});

describe("documentLineMatchStatus", () => {
  it("0개면 AWAITING", () => {
    expect(documentLineMatchStatus(3, 0)).toBe("AWAITING");
  });

  it("예정보다 적으면 PARTIAL", () => {
    expect(documentLineMatchStatus(3, 1)).toBe("PARTIAL");
  });

  it("예정과 같으면 COMPLETE", () => {
    expect(documentLineMatchStatus(3, 3)).toBe("COMPLETE");
  });

  it("예정을 넘으면 OVER", () => {
    expect(documentLineMatchStatus(3, 4)).toBe("OVER");
  });
});

describe("suggestDocumentLinesForScan", () => {
  it("허용오차는 ±10%", () => {
    expect(LINE_SUGGESTION_WEIGHT_TOLERANCE_RATIO).toBe(0.1);
  });

  it("축종이 서로 맞고 중량이 ±10% 안이면 확인된 제안", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10.5, speciesGroup: "돼지" },
      [{ lineId: "line-1", itemText: "돈육 삼겹살", expectedUnitWeight: 10 }]
    );

    expect(result).toEqual([{ lineId: "line-1", speciesConfirmed: true }]);
  });

  it("중량이 10% 경계를 넘으면 제안하지 않는다", () => {
    const withinBoundary = suggestDocumentLinesForScan(
      { weight: 11, speciesGroup: "돼지" },
      [{ lineId: "line-1", itemText: "돈육 삼겹살", expectedUnitWeight: 10 }]
    );
    const overBoundary = suggestDocumentLinesForScan(
      { weight: 11.01, speciesGroup: "돼지" },
      [{ lineId: "line-1", itemText: "돈육 삼겹살", expectedUnitWeight: 10 }]
    );

    expect(withinBoundary).toEqual([{ lineId: "line-1", speciesConfirmed: true }]);
    expect(overBoundary).toEqual([]);
  });

  it("축종이 서로 다르면 중량이 맞아도 제안하지 않는다", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: "소" },
      [{ lineId: "line-1", itemText: "돈육 삼겹살", expectedUnitWeight: 10 }]
    );

    expect(result).toEqual([]);
  });

  it("박스 축종을 모르면 중량만으로 제안하되 미확인 표시", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: null },
      [{ lineId: "line-1", itemText: "돈육 삼겹살", expectedUnitWeight: 10 }]
    );

    expect(result).toEqual([{ lineId: "line-1", speciesConfirmed: false }]);
  });

  it("줄 품목명에 축종 단어가 없으면(또는 둘 이상이면) 중량만으로 미확인 제안", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: "돼지" },
      [{ lineId: "line-1", itemText: "냉장 정육", expectedUnitWeight: 10 }]
    );

    expect(result).toEqual([{ lineId: "line-1", speciesConfirmed: false }]);
  });

  it("표기중량 정보가 없는 줄(expectedUnitWeight null)은 후보에서 제외", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: "돼지" },
      [{ lineId: "line-1", itemText: "돈육 삼겹살", expectedUnitWeight: null }]
    );

    expect(result).toEqual([]);
  });

  it("여러 줄 중 조건에 맞는 것만 돌려준다", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: "돼지" },
      [
        { lineId: "match", itemText: "돈육 삼겹살", expectedUnitWeight: 10 },
        { lineId: "wrong-species", itemText: "한우 등심", expectedUnitWeight: 10 },
        { lineId: "wrong-weight", itemText: "돈육 목살", expectedUnitWeight: 30 },
      ]
    );

    expect(result).toEqual([{ lineId: "match", speciesConfirmed: true }]);
  });

  it("박스 부위가 적힌 줄이 있으면 그 줄로 좁히고 부위 확인 표시를 붙인다", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: "소", partName: "등심" },
      [
        { lineId: "sirloin", itemText: "한우 등심 1++", expectedUnitWeight: 10 },
        { lineId: "tenderloin", itemText: "한우 안심 1++", expectedUnitWeight: 10 },
      ]
    );

    expect(result).toEqual([{ lineId: "sirloin", speciesConfirmed: true, partConfirmed: true }]);
  });

  it("부위 표기 띄어쓰기가 달라도 같은 부위로 본다", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: "소", partName: "채 끝" },
      [{ lineId: "line-1", itemText: "한우 채끝", expectedUnitWeight: 10 }]
    );

    expect(result).toEqual([{ lineId: "line-1", speciesConfirmed: true, partConfirmed: true }]);
  });

  it("박스 부위가 어느 줄에도 없으면(표기 차이일 수 있어) 좁히지 않는다", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: "소", partName: "LA갈비" },
      [
        { lineId: "a", itemText: "한우 갈비", expectedUnitWeight: 10 },
        { lineId: "b", itemText: "한우 양지", expectedUnitWeight: 10 },
      ]
    );

    expect(result).toEqual([
      { lineId: "a", speciesConfirmed: true },
      { lineId: "b", speciesConfirmed: true },
    ]);
  });

  it("박스 부위를 모르면(null) 좁히지 않는다", () => {
    const result = suggestDocumentLinesForScan(
      { weight: 10, speciesGroup: "소", partName: null },
      [{ lineId: "line-1", itemText: "한우 등심", expectedUnitWeight: 10 }]
    );

    expect(result).toEqual([{ lineId: "line-1", speciesConfirmed: true }]);
  });
});

describe("effectiveCountMode — 줄마다 박스 수/무게 중 무엇으로 세는가", () => {
  const base = { quantity: null, labeledWeight: null, traceNo: null } as const;

  it("표기중량이 없으면 무엇이든 박스 수(무게로 못 센다)", () => {
    expect(effectiveCountMode({ ...base, traceNo: "002191840078" })).toBe("BOXES");
    expect(effectiveCountMode({ ...base, traceNo: "002191840078", countMode: "WEIGHT" })).toBe("BOXES");
  });

  it("개체번호(12자리) 줄은 표기중량이 있으면 수량이 있어도 무게", () => {
    expect(effectiveCountMode({ ...base, traceNo: "002191840078", labeledWeight: 10 })).toBe("WEIGHT");
    expect(effectiveCountMode({ ...base, traceNo: "002191840078", labeledWeight: 10, quantity: 3 })).toBe("WEIGHT");
  });

  it("로트번호 줄: 수량이 있으면 박스 수, 수량이 없고 무게만 있으면 무게", () => {
    expect(effectiveCountMode({ ...base, traceNo: "L20260901000001", labeledWeight: 30, quantity: 3 })).toBe("BOXES");
    expect(effectiveCountMode({ ...base, traceNo: "L20260901000001", labeledWeight: 30 })).toBe("WEIGHT");
  });

  it("번호 없는 줄: 수량 없이 무게만 있으면 무게, 수량이 있으면 박스 수", () => {
    expect(effectiveCountMode({ ...base, labeledWeight: 20 })).toBe("WEIGHT");
    expect(effectiveCountMode({ ...base, labeledWeight: 20, quantity: 2 })).toBe("BOXES");
  });

  it("번호를 나눈 줄('(이력번호 k/N)')은 합계가 첫 줄에만 있어 박스 수", () => {
    expect(
      effectiveCountMode({ ...base, traceNo: "002191840078", labeledWeight: 24.5, rawText: "한우 등심 3개 (이력번호 1/3)" })
    ).toBe("BOXES");
  });

  it("사무실이 고정한 기준이 자동 규칙보다 우선(단 무게 고정은 표기중량이 있을 때만)", () => {
    expect(effectiveCountMode({ ...base, traceNo: "002191840078", labeledWeight: 10, countMode: "BOXES" })).toBe("BOXES");
    expect(effectiveCountMode({ ...base, quantity: 2, labeledWeight: 20, countMode: "WEIGHT" })).toBe("WEIGHT");
  });
});

describe("lineArrival", () => {
  const weightLine = { quantity: null, labeledWeight: 10, traceNo: "002191840078" } as const;

  it("무게 기준: 박스가 없으면 아직 안 옴, 하나도 자리가 남는다", () => {
    const arrival = lineArrival(weightLine, []);

    expect(arrival).toMatchObject({ mode: "WEIGHT", status: "AWAITING", roomLeft: true, remainingBoxes: 1, linkedBoxes: 0 });
  });

  it("무게 기준: 한 마리가 세 박스로 나뉘어 와도 무게 합이 표기 ±2% 안이면 다 옴", () => {
    const arrival = lineArrival(weightLine, [3.4, 3.3, 3.2]);

    expect(arrival).toMatchObject({ status: "COMPLETE", linkedBoxes: 3, linkedWeight: 9.9, roomLeft: false, remainingBoxes: 0 });
  });

  it("무게 기준: 모자라면 일부만 옴, 넘으면 더 많이 옴, 경계(±2%)는 다 옴", () => {
    expect(lineArrival(weightLine, [6]).status).toBe("PARTIAL");
    expect(lineArrival(weightLine, [9.8]).status).toBe("COMPLETE");
    expect(lineArrival(weightLine, [10.2]).status).toBe("COMPLETE");
    expect(lineArrival(weightLine, [9.79]).status).toBe("PARTIAL");
    expect(lineArrival(weightLine, [10.21]).status).toBe("OVER");
  });

  it("박스 수 기준: 예정 수량과 이어진 박스 수로 판정한다(수량 없으면 1박스)", () => {
    const boxLine = { quantity: 3, labeledWeight: 30, traceNo: "L20260901000001" } as const;

    expect(lineArrival(boxLine, [10, 10])).toMatchObject({ mode: "BOXES", status: "PARTIAL", remainingBoxes: 1, roomLeft: true });
    expect(lineArrival(boxLine, [10, 10, 10])).toMatchObject({ status: "COMPLETE", remainingBoxes: 0 });
    expect(lineArrival({ quantity: null, labeledWeight: null, traceNo: "002191840078" }, [5, 5])).toMatchObject({ status: "OVER" });
  });
});

describe("suggestDocumentLinesForScan — 무게 기준 줄", () => {
  it("남은 무게를 넘지 않는 박스만 후보(한 줄이 여러 박스로 와도 된다)", () => {
    const lines = [{ lineId: "w", itemText: "한우 등심", expectedUnitWeight: null, remainingWeight: 7 }];

    expect(suggestDocumentLinesForScan({ weight: 3.4, speciesGroup: "소" }, lines)).toEqual([{ lineId: "w", speciesConfirmed: true }]);
    expect(suggestDocumentLinesForScan({ weight: 7.1, speciesGroup: "소" }, lines)).toEqual([{ lineId: "w", speciesConfirmed: true }]);
    expect(suggestDocumentLinesForScan({ weight: 8, speciesGroup: "소" }, lines)).toEqual([]);
  });

  it("남은 무게가 없으면 후보가 아니다", () => {
    expect(
      suggestDocumentLinesForScan({ weight: 1, speciesGroup: "소" }, [{ lineId: "w", itemText: "한우 등심", expectedUnitWeight: null, remainingWeight: 0 }])
    ).toEqual([]);
  });
});

describe("pickLineByPart", () => {
  const lines = [
    { lineId: "sirloin", itemText: "한우 등심" },
    { lineId: "tenderloin", itemText: "한우 안심" },
  ];

  it("박스 부위가 적힌 줄이 하나면 그 줄", () => {
    expect(pickLineByPart(lines, "안심")).toBe("tenderloin");
  });

  it("부위를 모르거나 어느 줄에도 없으면 null", () => {
    expect(pickLineByPart(lines, null)).toBeNull();
    expect(pickLineByPart(lines, "양지")).toBeNull();
  });

  it("부위가 적힌 줄이 여럿이면 null", () => {
    expect(pickLineByPart([...lines, { lineId: "sirloin2", itemText: "한우 등심 2" }], "등심")).toBeNull();
  });
});

describe("pickAutoLinkLine", () => {
  it("후보가 하나이고 축종·부위가 모두 확인되면 그 줄", () => {
    expect(pickAutoLinkLine([{ lineId: "line-1", speciesConfirmed: true, partConfirmed: true }])).toBe("line-1");
  });

  it("후보가 없거나 여럿이면 null", () => {
    expect(pickAutoLinkLine([])).toBeNull();
    expect(
      pickAutoLinkLine([
        { lineId: "a", speciesConfirmed: true, partConfirmed: true },
        { lineId: "b", speciesConfirmed: true, partConfirmed: true },
      ])
    ).toBeNull();
  });

  it("무게+축종만 맞고 부위를 확인하지 못했으면 null", () => {
    expect(pickAutoLinkLine([{ lineId: "line-1", speciesConfirmed: true }])).toBeNull();
  });

  it("축종을 몰랐으면 부위가 맞아도 null", () => {
    expect(pickAutoLinkLine([{ lineId: "line-1", speciesConfirmed: false, partConfirmed: true }])).toBeNull();
  });
});
