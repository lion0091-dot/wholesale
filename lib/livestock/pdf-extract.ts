/**
 * PDF 명세서에서 표를 되살린다 (29단계 A).
 *
 * 글자만 이어붙이면 칸 경계가 사라진다. 실제로 이 저장소에서 만든 표 PDF를
 * 뽑아보면 한 줄이 이렇게 나온다:
 *
 *   한우 등심 1++ 002191840078 8.20 52,000 426,400
 *
 * 띄어쓰기로 자르면 품목명("한우 등심 1++")이 세 조각이 나고, 금액의 천단위
 * 쉼표와도 엉킨다. 더 나쁜 건 **칸 하나가 비었을 때**다 — 이력번호가 없는 줄은
 * 토큰이 하나 모자라서 뒤가 전부 한 칸씩 밀리고, 중량 자리에 단가가 들어간다.
 * 매입금액이 통째로 틀어지는 사고다.
 *
 * 그래서 글자마다 종이 위 좌표(x, y)를 같이 읽어 세로줄을 복원한다. 빈 칸은
 * 그 x 구간에 글자가 없다는 사실로 드러나므로 빈 칸인 채로 남는다.
 *
 * 스캔본·사진 PDF는 글자 정보가 아예 없어 여기서 빈 결과가 나온다 — 그건
 * 실패가 아니라 "읽을 수 없는 문서"라는 판정이고, 원본 보관으로 넘어간다.
 */

/** 같은 줄로 볼 세로 거리(pt). 본문 글꼴 10pt 기준 줄간격보다 작게 잡는다. */
const ROW_TOLERANCE = 3;

/** 같은 세로줄로 볼 가로 거리(pt). 칸 사이 여백보다 작게 잡는다. */
const COLUMN_TOLERANCE = 6;

/** 표로 볼 최소 줄 수 — 이보다 적으면 표가 아니라 안내문으로 본다. */
const MIN_TABLE_ROWS = 2;

export interface PdfTable {
  cells: string[][];
  pageCount: number;
  /** 글자가 하나라도 있었나. false면 스캔본·사진 PDF다. */
  hasText: boolean;
  /** 표 모양을 복원하기 전의 원문 — 사람이 대조할 때 쓴다. */
  rawText: string;
}

interface PositionedItem {
  text: string;
  x: number;
  y: number;
}

/** 가까운 값끼리 묶어 대표값(가장 왼쪽)을 돌려준다. */
function clusterPositions(values: number[], tolerance: number): number[] {
  if (values.length === 0) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[] = [sorted[0]];

  for (const value of sorted) {
    if (value - clusters[clusters.length - 1] > tolerance) {
      clusters.push(value);
    }
  }

  return clusters;
}

/** 좌표가 붙은 글자 조각들을 표로 복원한다. */
export function buildTableFromItems(items: PositionedItem[]): string[][] {
  if (items.length === 0) return [];

  // 1) y가 비슷한 것끼리 한 줄로 묶는다. PDF의 y는 위로 갈수록 커지므로 내림차순.
  const byRow = new Map<number, PositionedItem[]>();
  const rowKeys: number[] = [];

  for (const item of [...items].sort((a, b) => b.y - a.y)) {
    const existing = rowKeys.find((key) => Math.abs(key - item.y) <= ROW_TOLERANCE);
    const key = existing ?? item.y;

    if (existing === undefined) rowKeys.push(key);

    const bucket = byRow.get(key);

    if (bucket) {
      bucket.push(item);
    } else {
      byRow.set(key, [item]);
    }
  }

  // 2) 세로줄 위치를 정한다.
  //    줄마다 따로 정하면 빈 칸이 있는 줄에서 칸이 밀린다 — 그게 이 모듈의 존재 이유다.
  //    다만 표 위의 제목·주소처럼 조각이 한두 개뿐인 줄까지 세로줄 계산에 넣으면
  //    엉뚱한 칸이 생기므로, 표처럼 생긴 줄(조각 3개 이상)만 기준으로 삼는다.
  const tableRowItems = rowKeys
    .map((key) => byRow.get(key) ?? [])
    .filter((bucket) => bucket.length >= 3)
    .flat();
  const columnStarts = clusterPositions(
    (tableRowItems.length > 0 ? tableRowItems : items).map((item) => item.x),
    COLUMN_TOLERANCE,
  );

  // 3) 각 글자를 자기 x보다 왼쪽에 있는 가장 가까운 세로줄에 넣는다.
  const rows: string[][] = [];

  for (const key of rowKeys) {
    const rowItems = (byRow.get(key) ?? []).sort((a, b) => a.x - b.x);
    const row = new Array<string>(columnStarts.length).fill("");

    for (const item of rowItems) {
      let column = 0;

      for (let index = 0; index < columnStarts.length; index += 1) {
        if (item.x + COLUMN_TOLERANCE >= columnStarts[index]) column = index;
      }

      row[column] = row[column] ? `${row[column]} ${item.text}` : item.text;
    }

    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row.map((cell) => cell.trim()));
    }
  }

  return rows;
}

/**
 * 어느 칸에도 글자가 없는 세로줄을 걷어낸다.
 * 표 위의 제목·주소 같은 한 줄짜리 글이 엉뚱한 세로줄을 만들어내기 때문이다.
 */
function dropEmptyColumns(rows: string[][]): string[][] {
  if (rows.length === 0) return rows;

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const keep: number[] = [];

  for (let column = 0; column < width; column += 1) {
    if (rows.some((row) => (row[column] ?? "").trim() !== "")) keep.push(column);
  }

  return rows.map((row) => keep.map((column) => row[column] ?? ""));
}

/**
 * PDF 바이트에서 표를 복원한다.
 *
 * unpdf는 서버리스를 염두에 둔 pdfjs 래퍼다. 브라우저 번들에 pdfjs를 싣지 않으려고
 * 서버에서만 돌린다 — 현장 화면을 무겁게 만들지 않는다.
 */
export async function extractPdfTable(data: Uint8Array): Promise<PdfTable> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);

  const items: PositionedItem[] = [];
  const textLines: string[] = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    for (const entry of content.items) {
      const item = entry as { str?: string; transform?: number[] };
      const text = (item.str ?? "").trim();

      if (!text || !item.transform) continue;

      items.push({ text, x: item.transform[4], y: item.transform[5] });
      textLines.push(text);
    }
  }

  const rows = dropEmptyColumns(buildTableFromItems(items));

  return {
    cells: rows.length >= MIN_TABLE_ROWS ? rows : [],
    pageCount: pdf.numPages,
    hasText: items.length > 0,
    rawText: textLines.join(" "),
  };
}
