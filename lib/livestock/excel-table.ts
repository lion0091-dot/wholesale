import readExcelFile from "read-excel-file/node";

/**
 * 엑셀(.xlsx) 파일의 표를 글자 격자로 바꾼다(string[][]).
 * 내용이 있는 첫 번째 시트를 읽는다.
 */
export interface ExcelTable {
  cells: string[][];
  sheetName: string;
  sheetCount: number;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));

  return String(value).trim();
}

export async function extractExcelTable(data: Uint8Array | Buffer): Promise<ExcelTable> {
  const sheets = (await readExcelFile(Buffer.from(data))) as Array<{ sheet: string; data: unknown[][] }>;
  const hasContent = (rows: unknown[][]) => rows.some((row) => row.some((cell) => cellText(cell) !== ""));
  const chosen = sheets.find((sheet) => hasContent(sheet.data));

  if (!chosen) {
    return { cells: [], sheetName: sheets[0]?.sheet ?? "", sheetCount: sheets.length };
  }

  const cells = chosen.data
    .map((row) => row.map(cellText))
    .filter((row) => row.some((cell) => cell !== ""));

  return { cells, sheetName: chosen.sheet, sheetCount: sheets.length };
}
