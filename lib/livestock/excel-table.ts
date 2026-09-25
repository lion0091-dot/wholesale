import readExcelFile from "read-excel-file/node";
import { STATEMENT_TEMPLATE_SHEET } from "./statement-template";

/**
 * 엑셀(.xlsx) 파일의 표를 글자 격자로 바꾼다 — PDF에서 표를 되살리는 것(pdf-extract.ts)과 같은 모양(string[][])이다.
 *
 * 우리 양식이면 "명세서" 시트, 아니면 첫 번째로 내용이 있는 시트를 읽는다.
 * 숫자 칸(엑셀이 앞 0을 지운 이력번호 등)은 글자로 바꿔 넘기고, 앞 0 복원은 document-parser가 한다.
 * CSV와 달리 엑셀 파일은 값이 그대로 들어 있어 12자리 번호가 2.12E+11로 깎이지 않는다.
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
  const chosen = sheets.find((sheet) => sheet.sheet === STATEMENT_TEMPLATE_SHEET && hasContent(sheet.data)) ?? sheets.find((sheet) => hasContent(sheet.data));

  if (!chosen) {
    return { cells: [], sheetName: sheets[0]?.sheet ?? "", sheetCount: sheets.length };
  }

  const cells = chosen.data
    .map((row) => row.map(cellText))
    .filter((row) => row.some((cell) => cell !== ""));

  return { cells, sheetName: chosen.sheet, sheetCount: sheets.length };
}
