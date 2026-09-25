import { describe, expect, it } from "vitest";
import { isMultiCellPaste, pasteIntoLines, type GridLine } from "./statement-grid";

const TAB = String.fromCharCode(9);
const empty = (): GridLine => ({ itemName: null, traceNo: null, lotNo: null, partName: null, grade: null, origin: null, quantity: null, labeledWeight: null, unitPrice: null, amount: null });
const row = (...cells: string[]) => cells.join(TAB);

describe("직접 입력 표 — 엑셀에서 복사한 여러 칸 붙여넣기", () => {
  it("한 칸짜리는 여러 칸 붙여넣기가 아니고, 탭이나 줄바꿈이 있으면 여러 칸이다", () => {
    expect(isMultiCellPaste("002123456781")).toBe(false);
    expect(isMultiCellPaste(row("안심", "002123456781"))).toBe(true);
    expect(isMultiCellPaste("안심" + String.fromCharCode(10) + "채끝")).toBe(true);
  });

  it("누른 칸부터 오른쪽·아래로 채우고, 모자란 줄은 늘린다(엑셀의 CRLF·끝 빈 줄 포함)", () => {
    const text = [row("한우 안심", "안심", "1++", "국내산", "002123456781", "", "1", "7.1", "90,000", "639,000"), row("한우 채끝", "채끝", "1+", "국내산", "002123456792", "", "2", "9.8", "70,000", "686,000"), ""].join("\r\n");
    // 첫 칸(품목, 열 0)이 아니라 부위 열(3)부터 붙여넣는 경우와 같이, 시작 열을 조절해 본다
    const start = pasteIntoLines([empty()], 0, 0, row("한우 안심", "002123456781", "", "안심", "1++", "국내산", "1", "7.1", "90,000", "639,000") + "\r\n" + row("한우 채끝", "002123456792", "", "채끝", "1+", "국내산", "2", "9.8", "70,000", "686,000") + "\r\n", empty);

    expect(start).toHaveLength(2);
    expect(start[0]).toMatchObject({ itemName: "한우 안심", traceNo: "002123456781", partName: "안심", grade: "1++", origin: "국내산", quantity: 1, labeledWeight: 7.1, unitPrice: 90000, amount: 639000 });
    expect(start[1]).toMatchObject({ itemName: "한우 채끝", partName: "채끝", quantity: 2, amount: 686000 });
    expect(text.length).toBeGreaterThan(0);
  });

  it("중간 열에서 시작해도 그 칸부터 채우고 앞 칸은 그대로 둔다 / 빈 칸은 그 칸을 비운다 / 이력번호의 공백은 지운다", () => {
    const base = [{ ...empty(), itemName: "기존 품목", traceNo: "111111111111" }];
    const out = pasteIntoLines(base, 0, 1, row("0021 2345 6781", "", "안심"), empty);

    expect(out[0]).toMatchObject({ itemName: "기존 품목", traceNo: "002123456781", lotNo: null, partName: "안심" });
  });

  it("원래 배열은 바꾸지 않고, 줄 밖으로 넘치는 열은 무시한다", () => {
    const base = [empty()];
    const out = pasteIntoLines(base, 0, 8, row("100", "200", "300", "400"), empty);

    expect(base[0].unitPrice).toBeNull();
    expect(out[0]).toMatchObject({ unitPrice: 100, amount: 200 });
  });
});
