import { describe, expect, it } from "vitest";
import {
  LINE_SUGGESTION_WEIGHT_TOLERANCE_RATIO,
  documentLineExpectedQty,
  documentLineMatchStatus,
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
});
