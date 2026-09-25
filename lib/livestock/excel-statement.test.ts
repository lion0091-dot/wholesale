import { describe, expect, it } from "vitest";
import writeExcelFile from "write-excel-file/node";
import { buildStatementTemplate, STATEMENT_TEMPLATE_HEADERS, STATEMENT_TEMPLATE_SHEET } from "./statement-template";
import { extractExcelTable } from "./excel-table";
import { applyColumnMap, buildGrid } from "./document-parser";

describe("명세서 입력 양식(.xlsx) — 내려받기 → 채우기 → 바로 올리기", () => {
  it("빈 양식은 xlsx이고 '명세서' 시트에 헤더 한 줄만 있다(예시 줄이 섞여 올라가지 않는다)", async () => {
    const buffer = await buildStatementTemplate();

    expect(buffer.subarray(0, 2).toString()).toBe("PK");

    const table = await extractExcelTable(buffer);

    expect(table.sheetName).toBe(STATEMENT_TEMPLATE_SHEET);
    expect(table.sheetCount).toBe(2);
    expect(table.cells).toEqual([[...STATEMENT_TEMPLATE_HEADERS]]);
  });

  it("양식의 헤더를 파서가 전부 알아본다 — 칸을 사람이 다시 짚을 필요가 없다", async () => {
    const table = await extractExcelTable(await buildStatementTemplate());
    const grid = buildGrid([...table.cells, ["한우 안심", "안심", "1++", "국내산", "002123456781", "", "1", "7.1", "90,000", "639,000"]]);

    expect(grid.columnMap).toEqual({ itemName: 0, partName: 1, grade: 2, origin: 3, traceNo: 4, lotNo: 5, quantity: 6, labeledWeight: 7, unitPrice: 8, amount: 9 });
  });

  it("양식에 채운 파일: 텍스트 이력번호·숫자로 저장돼 앞 0이 지워진 이력번호·빈 칸이 모두 줄로 정확히 읽힌다", async () => {
    // 사람이 양식에 적어 저장한 것을 흉내낸다 — 이력번호는 텍스트 칸(문자열)과 일반 칸(숫자, 앞 0 탈락) 두 가지가 다 온다
    const filled = await writeExcelFile([
      {
        data: [
          STATEMENT_TEMPLATE_HEADERS.map((value) => ({ value })),
          ["한우 안심", "안심", "1++", "국내산", { value: "002123456781", type: String }, null, 1, 7.1, 90000, 639000],
          ["한우 채끝", "채끝", "1+", "국내산", { value: 2123456792, type: Number }, null, 2, 9.8, 70000, 686000],
          ["부산물 모음", null, null, "국내산", null, null, null, 5, 3000, 15000],
        ] as never,
        sheet: STATEMENT_TEMPLATE_SHEET,
      },
    ] as never).toBuffer();
    const table = await extractExcelTable(filled);
    const grid = buildGrid(table.cells);
    const lines = applyColumnMap(grid, grid.columnMap);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ itemName: "한우 안심", partName: "안심", grade: "1++", traceNo: "002123456781", quantity: 1, labeledWeight: 7.1, unitPrice: 90000, amount: 639000 });
    // 엑셀이 앞 0을 지운 숫자 이력번호도 12자리로 복원된다
    expect(lines[1]).toMatchObject({ partName: "채끝", traceNo: "002123456792", quantity: 2 });
    // 이력번호·부위가 빈 줄도 뒤 칸이 밀리지 않는다
    expect(lines[2]).toMatchObject({ itemName: "부산물 모음", traceNo: null, labeledWeight: 5, unitPrice: 3000, amount: 15000 });
  });

  it("우리 양식이 아닌 엑셀(시트 이름이 다르고 부위 칸이 없는 공급처 파일)도 첫 내용 시트를 읽는다", async () => {
    const other = await writeExcelFile([
      { data: [[{ value: "메모" }]] as never, sheet: "표지" },
      { data: [["품명", "중량", "단가", "금액"].map((value) => ({ value })), ["삼겹살", 10.5, 18000, 189000]] as never, sheet: "Sheet1" },
    ] as never).toBuffer();
    const table = await extractExcelTable(other);

    expect(table.sheetName).toBe("표지");
  });

  it("내용이 전혀 없는 엑셀은 빈 표를 돌려준다", async () => {
    const empty = await writeExcelFile([{ data: [[null]] as never, sheet: "빈 시트" }] as never).toBuffer();

    expect((await extractExcelTable(empty)).cells).toEqual([]);
  });
});
