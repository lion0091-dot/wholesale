/**
 * 공급처 원본 명세서 파싱 (29단계 A).
 *
 * 기존 import-parser는 "우리가 정한 형식"(0번 칸 이력번호, 1번 칸 중량)만 읽는다.
 * 공급처가 주는 거래명세서/납품명세서는 칸 순서도 이름도 업체마다 다르므로,
 * 여기서는 격자로 쪼갠 뒤 "어느 칸이 무엇인지"를 추측하는 층을 따로 둔다.
 *
 * 추측은 어디까지나 초안이다 — 화면에서 사람이 고치고, 고친 결과는
 * supplier_document_formats에 저장돼 같은 공급처 서류는 다음부터 그대로 읽는다.
 * 틀리게 읽은 값이 그대로 매입금액이 되면 안 되기 때문에 자동 확정은 하지 않는다.
 */

import { parseBarcode } from "./barcode-parser";
import { detectDelimiter, splitLine } from "./import-parser";

export type DocumentField =
  | "itemName"
  | "traceNo"
  | "partName"
  | "grade"
  | "origin"
  | "quantity"
  | "labeledWeight"
  | "unitPrice"
  | "amount";

export type ColumnMap = Partial<Record<DocumentField, number>>;

export interface DocumentGrid {
  /** 구분자로 쪼갠 전체 격자. 헤더 줄도 들어 있다. */
  cells: string[][];
  /** 헤더로 판정한 줄의 인덱스. 없으면 null. */
  headerRowIndex: number | null;
  /** 칸 추측 결과. 화면에서 사람이 고칠 수 있다. */
  columnMap: ColumnMap;
  /** 합계/소계로 보여 품목 줄이 아닌 것으로 판정한 줄 인덱스. */
  totalRowIndexes: number[];
}

export interface DocumentLine {
  lineNo: number;
  raw: string;
  itemName: string | null;
  traceNo: string | null;
  /**
   * 부위(안심/등심/삼겹살 등). 보통 품목명 칸에 같이 적혀 오지만(예: "한우
   * 등심 1++"), 화면에서 사람이 따로 뽑아 적으면 자동 상품 생성이 "(부위
   * 미지정)" 대신 이 값을 쓴다(2026-09-24, 사장님 확정: 명세서 기반이니
   * 부위를 모를 일이 없어야 한다).
   */
  partName: string | null;
  /** 1++, 1+, 1, 2, 3 등. 이력번호가 있으면 공공조회 값이 우선이다. */
  grade: string | null;
  /** 국내산 / 미국산 등. 원산지 허위표시로 이어질 수 있어 필수로 본다. */
  origin: string | null;
  quantity: number | null;
  labeledWeight: number | null;
  unitPrice: number | null;
  amount: number | null;
}

/**
 * 헤더 이름 후보. 공급처마다 표기가 달라 부분일치로 본다.
 * 순서가 중요하다 — 먼저 걸린 쪽이 이긴다. 예를 들어 "공급가액"은
 * "단가"보다 "금액" 쪽에 먼저 걸려야 한다.
 */
const HEADER_PATTERNS: Array<{ field: DocumentField; patterns: RegExp[] }> = [
  { field: "traceNo", patterns: [/이력/, /개체번호/, /묶음번호/, /trace/i] },
  // 실제로는 "품명(규격/부위)"처럼 품목명 칸에 부위가 같이 적혀 오는 경우가
  // 대부분이라(2026-09-24 실제 명세서 서식으로 확인) 이 패턴이 걸리는 일은
  // 드물다. 그래도 부위를 따로 칸으로 주는 공급처가 있을 수 있어 남겨둔다 —
  // 못 걸리면 화면에서 사람이 직접 입력한다.
  { field: "partName", patterns: [/부위/, /부속/] },
  { field: "grade", patterns: [/등급/, /육질/, /grade/i] },
  { field: "origin", patterns: [/원산지/, /산지/, /origin/i] },
  {
    field: "amount",
    patterns: [/공급가/, /금액/, /합계금액/, /매입액/, /amount/i],
  },
  { field: "unitPrice", patterns: [/단가/, /kg\s*당/i, /unit\s*price/i] },
  // 서류에 "실중량"이라 적혀 있어도 우리 입장에선 공급처가 주장하는 값이다.
  // 우리 저울로 잰 값(inbound_scans.weight)과 대조할 대상이므로 표기중량으로 받는다.
  { field: "labeledWeight", patterns: [/중량/, /실중량/, /무게/, /\bkg\b/i, /weight/i] },
  { field: "quantity", patterns: [/수량/, /박스/, /개수/, /두수/, /팩수/, /\bea\b/i, /qty/i] },
  {
    field: "itemName",
    patterns: [/품목/, /품명/, /상품/, /제품/, /규격/, /내역/, /item/i, /product/i],
  },
];

/** 합계 줄은 품목이 아니다 — 잘못 넣으면 중량·금액이 두 배가 된다. */
const TOTAL_ROW_PATTERN = /^(합\s*계|총\s*계|소\s*계|계|total|sum)$/i;

/**
 * 축산물 등급 표기. 소는 1++·1+·1·2·3, 돼지는 1+·1·2가 쓰인다.
 * "1++등급", "1+ 등급" 같은 표기도 받는다.
 */
const GRADE_PATTERN = /^([123])(\+{1,2})?\s*(등급)?$/;

/**
 * 원산지 표기. **칸 전체가 원산지일 때만** 인정한다 — "한우"는 품목명에도
 * 흔히 나오므로 부분일치를 쓰면 품목명 칸을 원산지로 잘못 잡는다.
 */
const DOMESTIC_ORIGIN = /^(국내산|국산|한우|한돈|국내)$/;
const IMPORT_ORIGIN =
  /^(수입|수입산|미국|미국산|호주|호주산|캐나다|캐나다산|뉴질랜드|뉴질랜드산|스페인|스페인산|덴마크|덴마크산|네덜란드|네덜란드산|칠레|칠레산|멕시코|멕시코산|브라질|브라질산|아르헨티나|아르헨티나산|프랑스|프랑스산|독일|독일산|오스트리아|오스트리아산|헝가리|헝가리산|폴란드|폴란드산)$/;

function looksLikeOrigin(value: string): boolean {
  const text = value.trim();

  return DOMESTIC_ORIGIN.test(text) || IMPORT_ORIGIN.test(text);
}

/** 같은 뜻의 여러 표기를 하나로 모은다 — 국산/한우/한돈은 전부 국내산이다. */
export function normalizeOrigin(value: string): string {
  const text = value.trim();

  if (DOMESTIC_ORIGIN.test(text)) return "국내산";

  return text;
}

/** "8.2", "8.2kg", "8,200", "1,234원" 같은 표기를 숫자로. 음수는 받지 않는다. */
export function parseNumber(value: string): number | null {
  if (!value) return null;

  // 천단위 쉼표는 버리고, 소수점만 남긴다.
  const cleaned = value.replace(/,/g, "").replace(/[^\d.]/g, "");

  if (!cleaned) return null;

  const parsed = Number.parseFloat(cleaned);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isTotalRow(cells: string[]): boolean {
  return cells.some((cell) => TOTAL_ROW_PATTERN.test(cell.trim()));
}

/** 헤더 줄 찾기 — 위에서부터 훑어 아는 헤더 이름이 2개 이상 걸리는 첫 줄. */
function findHeaderRow(cells: string[][]): number | null {
  const limit = Math.min(cells.length, 10);

  for (let index = 0; index < limit; index += 1) {
    const matched = new Set<DocumentField>();

    cells[index].forEach((cell) => {
      const field = matchHeaderCell(cell);

      if (field) matched.add(field);
    });

    if (matched.size >= 2) return index;
  }

  return null;
}

function matchHeaderCell(cell: string): DocumentField | null {
  const text = cell.trim();

  if (!text) return null;

  for (const { field, patterns } of HEADER_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) return field;
  }

  return null;
}

/** 헤더 이름으로 칸 찾기. 같은 뜻의 칸이 여럿이면 처음 것을 쓴다. */
function mapByHeader(headerCells: string[]): ColumnMap {
  const map: ColumnMap = {};

  headerCells.forEach((cell, index) => {
    const field = matchHeaderCell(cell);

    if (field && map[field] === undefined) {
      map[field] = index;
    }
  });

  return map;
}

/**
 * 헤더가 없거나 빈 칸이 남았을 때 내용으로 추측한다.
 * 판정은 보수적으로 — 애매하면 비워두고 사람에게 맡긴다.
 */
function mapByContent(bodyRows: string[][], existing: ColumnMap): ColumnMap {
  const map: ColumnMap = { ...existing };
  const columnCount = bodyRows.reduce((max, row) => Math.max(max, row.length), 0);
  const taken = new Set(Object.values(map));

  const stats = Array.from({ length: columnCount }, (_, column) => {
    const values = bodyRows.map((row) => (row[column] ?? "").trim()).filter(Boolean);
    const numbers = values.map(parseNumber).filter((n): n is number => n !== null);

    return {
      column,
      values,
      numbers,
      /** 이력번호로 읽히는 칸인지 */
      traceHits: values.filter((v) => parseBarcode(v).traceNo !== null).length,
      /** 한글/영문이 섞인 칸인지 (품목명 후보) */
      textHits: values.filter((v) => /[가-힣A-Za-z]/.test(v)).length,
      /** 등급 표기로 읽히는 칸인지 */
      gradeHits: values.filter((v) => GRADE_PATTERN.test(v)).length,
      /** 원산지 표기로 읽히는 칸인지 */
      originHits: values.filter((v) => looksLikeOrigin(v)).length,
      numericRatio: values.length ? numbers.length / values.length : 0,
    };
  });

  const claim = (field: DocumentField, column: number | undefined) => {
    if (column === undefined) return;
    if (map[field] !== undefined) return;
    if (taken.has(column)) return;

    map[field] = column;
    taken.add(column);
  };

  // 이력번호: 대부분의 값이 이력번호로 읽히는 칸.
  claim(
    "traceNo",
    stats.find((s) => s.values.length > 0 && s.traceHits / s.values.length >= 0.6)?.column,
  );

  // 등급: 대부분의 값이 등급 표기인 칸. 품목명보다 먼저 잡아야 한다 —
  // "1++"는 글자가 아니지만 품목명 칸이 먼저 가져가면 등급을 놓친다.
  claim(
    "grade",
    stats.find((s) => s.values.length > 0 && s.gradeHits / s.values.length >= 0.6)?.column,
  );

  // 원산지: 등급과 같은 이유로 품목명보다 먼저 잡는다.
  claim(
    "origin",
    stats.find((s) => s.values.length > 0 && s.originHits / s.values.length >= 0.6)?.column,
  );

  // 품목명: 글자가 가장 많이 섞인 칸.
  const textColumn = [...stats]
    .filter((s) => !taken.has(s.column) && s.textHits > 0)
    .sort((a, b) => b.textHits - a.textHits)[0];

  claim("itemName", textColumn?.column);

  // 숫자 칸들만 남겨 크기 순으로 성격을 가른다.
  // 명세서의 숫자 칸은 보통 수량 < 중량 < 단가 < 금액 순으로 자릿수가 커진다.
  const numericColumns = stats
    .filter((s) => !taken.has(s.column) && s.numericRatio >= 0.6 && s.numbers.length > 0)
    .map((s) => ({
      column: s.column,
      median: median(s.numbers),
      hasDecimal: s.numbers.some((n) => !Number.isInteger(n)),
    }));

  // 금액은 가장 큰 값. 단가가 그다음.
  const byMedian = [...numericColumns].sort((a, b) => b.median - a.median);

  claim("amount", byMedian[0]?.column);
  claim("unitPrice", byMedian[1]?.column);

  // 중량은 남은 것 중 소수점이 있는 칸을 우선한다(8.20 같은 실중량).
  const remaining = numericColumns.filter((c) => !taken.has(c.column));

  claim("labeledWeight", remaining.find((c) => c.hasDecimal)?.column ?? remaining[0]?.column);
  claim("quantity", numericColumns.find((c) => !taken.has(c.column))?.column);

  return map;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 붙여넣기/CSV 텍스트를 격자로 쪼개고 칸 뜻을 추측한다. */
export function parseDocumentText(text: string): DocumentGrid {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return { cells: [], headerRowIndex: null, columnMap: {}, totalRowIndexes: [] };
  }

  const delimiter = detectDelimiter(lines[0]);

  return buildGrid(lines.map((line) => splitLine(line, delimiter)));
}

/**
 * 이미 칸으로 나뉜 격자에서 헤더와 칸 뜻을 추측한다.
 *
 * PDF는 텍스트를 이어붙이면 칸 경계가 사라지므로(빈 칸이 있으면 나머지가 밀린다)
 * 좌표로 세로줄을 복원한 격자를 따로 만들어 여기로 들여보낸다.
 */
export function buildGrid(cells: string[][]): DocumentGrid {
  if (cells.length === 0) {
    return { cells: [], headerRowIndex: null, columnMap: {}, totalRowIndexes: [] };
  }

  const headerRowIndex = findHeaderRow(cells);
  const totalRowIndexes = cells
    .map((row, index) => (isTotalRow(row) ? index : -1))
    .filter((index) => index >= 0);

  const bodyRows = cells.filter(
    (_, index) => index !== headerRowIndex && !totalRowIndexes.includes(index),
  );

  const headerMap = headerRowIndex !== null ? mapByHeader(cells[headerRowIndex]) : {};
  const columnMap = mapByContent(bodyRows, headerMap);

  return { cells, headerRowIndex, columnMap, totalRowIndexes };
}

export interface ApplyOptions {
  /** 사람이 헤더 줄을 직접 지정한 경우. null이면 헤더 없음으로 본다. */
  headerRowIndex?: number | null;
  /** 사람이 "이 줄은 빼달라"고 고른 줄들. */
  excludeRowIndexes?: number[];
}

/**
 * 격자 + 칸 지정 → 저장할 품목 줄들. 헤더와 합계 줄은 빠진다.
 *
 * 추측이 틀렸을 때 사람이 화면에서 고치는 게 정상 경로라, 칸뿐 아니라
 * 헤더 줄과 제외할 줄도 함께 덮어쓸 수 있어야 한다.
 */
export function applyColumnMap(
  grid: DocumentGrid,
  columnMap: ColumnMap,
  options: ApplyOptions = {},
): DocumentLine[] {
  const lines: DocumentLine[] = [];
  const headerRowIndex =
    options.headerRowIndex !== undefined ? options.headerRowIndex : grid.headerRowIndex;
  const excluded = new Set([...grid.totalRowIndexes, ...(options.excludeRowIndexes ?? [])]);

  grid.cells.forEach((row, index) => {
    if (index === headerRowIndex) return;
    // 헤더 위쪽은 문서 머리말이다 — 제목("거래명세서"), 공급처·날짜 줄이 여기 온다.
    // 품목으로 넣으면 첫 줄이 통째로 밀린다(PDF에서 실제로 겪음).
    if (headerRowIndex !== null && headerRowIndex !== undefined && index < headerRowIndex) return;
    if (excluded.has(index)) return;

    const pick = (field: DocumentField): string => {
      const column = columnMap[field];

      return column === undefined ? "" : (row[column] ?? "").trim();
    };

    const rawTrace = pick("traceNo");
    // 셀에 바코드 원문이 그대로 들어있는 경우가 있어 한 번 태운다.
    const traceNo = rawTrace ? (parseBarcode(rawTrace).traceNo ?? rawTrace) : null;
    const itemName = pick("itemName") || null;
    const partName = pick("partName") || null;
    // "1++등급" 같은 표기에서 등급만 남긴다.
    const rawGrade = pick("grade");
    const gradeMatch = rawGrade.match(GRADE_PATTERN);
    const grade = gradeMatch ? `${gradeMatch[1]}${gradeMatch[2] ?? ""}` : rawGrade || null;
    const rawOrigin = pick("origin");
    const origin = rawOrigin ? normalizeOrigin(rawOrigin) : null;
    const labeledWeight = parseNumber(pick("labeledWeight"));
    const quantity = parseNumber(pick("quantity"));
    const unitPrice = parseNumber(pick("unitPrice"));
    const amount = parseNumber(pick("amount"));

    // 아무것도 못 읽은 줄은 버린다 (구분선, 빈 줄 등).
    if (!itemName && !traceNo && labeledWeight === null && amount === null) return;

    lines.push({
      lineNo: lines.length + 1,
      raw: row.join(" | "),
      itemName,
      traceNo,
      partName,
      grade,
      origin,
      quantity,
      labeledWeight,
      unitPrice,
      amount,
    });
  });

  return lines;
}
