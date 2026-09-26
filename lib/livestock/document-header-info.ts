/**
 * 전표 머리글(품목 표 위쪽)에서 전표번호를 읽는다. "전표번호: A-100"처럼 한 칸에 붙어 있거나,
 * "전표번호" 칸 옆 칸에 값이 있는 두 가지 모양을 다룬다.
 * 이력번호·묶음번호·개체번호·사업자등록번호·일련번호는 라벨 목록에 없어 절대 잡히지 않는다.
 */

const LABEL = /^(?:거래\s*명세서|거래\s*명세|명세서|명세|전표|문서|거래|출고|납품|주문|송장)\s*(?:번호|no\.?|#)\s*[:：]?\s*(.*)$/i;
const VALUE = /^[A-Za-z0-9][A-Za-z0-9\-_/]{2,29}$/;

/** 머리글로 볼 범위 — 헤더 줄이 있으면 그 위, 없으면 위쪽 몇 줄. 품목 줄 안의 값을 번호로 오인하지 않게 좁힌다. */
const MAX_SCAN_ROWS = 12;

export function extractDocumentNo(cells: string[][], headerRowIndex: number | null): string | null {
  const limit = headerRowIndex === null ? Math.min(cells.length, MAX_SCAN_ROWS) : Math.min(headerRowIndex, MAX_SCAN_ROWS);

  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const row = cells[rowIndex] ?? [];

    for (let col = 0; col < row.length; col += 1) {
      const match = LABEL.exec((row[col] ?? "").trim());

      if (!match) continue;

      const inline = match[1].trim();
      const candidate = inline || (row.slice(col + 1).find((cell) => (cell ?? "").trim() !== "") ?? "").trim();

      if (VALUE.test(candidate)) return candidate;
    }
  }

  return null;
}
