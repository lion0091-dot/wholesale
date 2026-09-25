import { describe, expect, it } from "vitest";
import { applyColumnMap, parseDocumentText } from "./document-parser";

/**
 * 종이 명세서를 사무실 PC에서 엑셀로 옮겨 적은 뒤 표를 복사해 "붙여넣기" 칸에 넣는 경우.
 * 엑셀 클립보드는 탭 구분 + 윈도우 줄바꿈이고, 숫자는 천 단위 쉼표가 붙으며, 빈 칸이 탭 사이에 그대로 남는다.
 */
const TAB = String.fromCharCode(9);
const row = (...cells: string[]) => cells.join(TAB);

describe("엑셀에서 복사한 표 붙여넣기 (사무실 PC)", () => {
  it("탭 구분·윈도우 줄바꿈·천 단위 쉼표·빈 이력번호 칸을 그대로 읽는다", () => {
    const text = [
      row("품목", "부위", "이력번호", "중량", "단가", "금액"),
      row("한우 안심", "안심", "002123456781", "7.10", "90,000", "639,000"),
      row("한우 채끝", "채끝", "002123456792", "9.80", "70,000", "686,000"),
      row("부산물 모음", "", "", "5.00", "3,000", "15,000"),
      "",
    ].join("\r\n");
    const grid = parseDocumentText(text);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ itemName: "한우 안심", partName: "안심", traceNo: "002123456781", labeledWeight: 7.1, unitPrice: 90000, amount: 639000 });
    expect(lines[1]).toMatchObject({ partName: "채끝", traceNo: "002123456792" });
    // 이력번호가 빈 줄도 중량·단가·금액이 한 칸씩 밀리지 않는다
    expect(lines[2]).toMatchObject({ itemName: "부산물 모음", traceNo: null, labeledWeight: 5, unitPrice: 3000, amount: 15000 });
  });

  it("엑셀이 12자리 번호를 과학표기(2.12E+11)나 0 탈락으로 바꿔 붙여넣어도 알아챈다는 안내 경로를 깨지 않는다(예외 없이 줄로 남는다)", () => {
    const text = [row("품목", "이력번호", "중량"), row("한우 등심", "2.12346E+11", "8.2")].join("\r\n");
    const grid = parseDocumentText(text);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(1);
    expect(lines[0].itemName).toBe("한우 등심");
  });
});
