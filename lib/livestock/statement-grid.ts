/**
 * 화면 직접 입력 표(전표 검토 화면)의 "엑셀처럼 붙여넣기".
 * 엑셀·구글 시트에서 복사한 표(탭 구분·줄바꿈)를 눌러 둔 칸부터 채우고, 줄이 모자라면 늘린다.
 * 열 순서는 화면 표의 입력 칸 순서와 같다.
 */
export interface GridLine {
  itemName: string | null;
  traceNo: string | null;
  lotNo: string | null;
  partName: string | null;
  grade: string | null;
  origin: string | null;
  quantity: number | null;
  labeledWeight: number | null;
  unitPrice: number | null;
  amount: number | null;
}

export const GRID_COLUMNS = ["itemName", "traceNo", "lotNo", "partName", "grade", "origin", "quantity", "labeledWeight", "unitPrice", "amount"] as const;

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

function toPositiveNumber(value: string): number | null {
  const parsed = Number.parseFloat(value.split(",").join("").trim());

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function applyGridCell<T extends GridLine>(line: T, col: number, raw: string): T {
  const value = raw.trim();
  const text = value || null;

  switch (col) {
    case 0:
      return { ...line, itemName: text };
    case 1:
      return { ...line, traceNo: value.split(" ").join("") || null };
    case 2:
      return { ...line, lotNo: text };
    case 3:
      return { ...line, partName: text };
    case 4:
      return { ...line, grade: text };
    case 5:
      return { ...line, origin: text };
    case 6:
      return { ...line, quantity: toPositiveNumber(value) };
    case 7:
      return { ...line, labeledWeight: toPositiveNumber(value) };
    case 8:
      return { ...line, unitPrice: toPositiveNumber(value) };
    case 9:
      return { ...line, amount: toPositiveNumber(value) };
    default:
      return line;
  }
}

/** 붙여넣은 글자가 여러 칸(탭 또는 줄바꿈이 있는)짜리인가 — 한 칸짜리는 입력창이 원래대로 처리한다. */
export function isMultiCellPaste(text: string): boolean {
  return text.includes(TAB) || text.includes(LF);
}

/** startIndex 줄·startCol 칸부터 붙여넣는다. 줄이 모자라면 makeEmpty로 만들어 늘린다(입력을 바꾸지 않고 새 배열을 돌려준다). */
export function pasteIntoLines<T extends GridLine>(lines: T[], startIndex: number, startCol: number, text: string, makeEmpty: (index: number) => T): T[] {
  const rows = text.split(CR).join("").split(LF);

  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();

  const next = [...lines];

  rows.forEach((row, offset) => {
    const index = startIndex + offset;

    while (next.length <= index) next.push(makeEmpty(next.length));

    let line = next[index];

    row.split(TAB).forEach((cell, cellOffset) => {
      line = applyGridCell(line, startCol + cellOffset, cell);
    });
    next[index] = line;
  });

  return next;
}
