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
import { parseTraceNumber } from "./trace-number";
import { detectDelimiter, splitLine } from "./import-parser";

export type DocumentField =
  | "itemName"
  | "traceNo"
  /**
   * 묶음(로트)번호 칸 — 이력번호 칸과 **나란히 둘 다** 있는 명세서에서만 쓴다.
   * 묶음번호만 적는 명세서(로트 단위 거래)는 예전처럼 traceNo 한 칸으로 읽는다 —
   * 재고 단위를 로트로 보는 잠긴 결정(2026-09-24)이 그대로다.
   */
  | "lotNo"
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
   * 묶음(로트)번호. 이력번호와 두 칸으로 나란히 오는 명세서에서만 채워진다 —
   * 묶음번호만 있는 명세서는 traceNo에 들어간다(DocumentField.lotNo 참고).
   * 저장 뒤 사전조회가 "이 이력번호가 정말 그 로트의 구성원인지"를 대조한다.
   */
  lotNo: string | null;
  /**
   * 이력번호 칸이 엑셀 과학표기(예: 1.4008E+11)로 잘려 와서 복원할 수 없었다.
   * 유효숫자가 모자라 뒷자리를 알 수 없으므로 번호를 만들어내지 않고 사람에게 알린다.
   */
  traceTruncated: boolean;
  /**
   * 원문 한 줄에 이력번호가 여럿 적혀 있어(소 3마리를 한 품목 줄로 등) 번호마다
   * 줄을 나눈 경우. index는 0부터. 중량·수량·금액은 첫 줄(index 0)에 원문 합계로
   * 남기고 나머지는 비운다 — 박스별 중량은 서류가 말해주지 않으므로 나눠 추정하지
   * 않는다(플랫폼은 미흡한 것만 알려주고 가정하지 않는다는 원칙). 단가는 같은
   * 고기라 전 줄에 복사한다.
   */
  splitOf: { index: number; count: number } | null;
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
  // "이력(묶음)번호"처럼 둘이 한 칸에 적힌 헤더는 이력번호 칸이다 — traceNo가 먼저 걸려야 한다.
  { field: "traceNo", patterns: [/이력/, /개체/, /trace/i] },
  // 묶음번호 칸이 따로 있을 때. 이력번호 칸이 없으면 buildGrid가 이 칸을 traceNo로 돌린다.
  { field: "lotNo", patterns: [/묶음/, /로트/, /lot/i] },
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

/** 정식 형태의 이력/묶음번호 — 개체 12자리, 묶음 L+14 또는 15자리. 앞뒤에 숫자·영문이 붙어 있으면 다른 번호의 일부다. */
const TRACE_TOKEN_PATTERN = /(?<![0-9A-Z])(L\d{14}|\d{15}|\d{12})(?![0-9A-Z])/g;

/** "1.4007700015E+11" 같은 엑셀 과학표기. */
const SCIENTIFIC_PATTERN = /^(\d)(?:\.(\d+))?E\+?(\d{1,2})$/i;

/** 한 칸을 번호 후보 덩어리로 나누는 강한 구분자 — 쉼표·세미콜론·슬래시·줄바꿈·세로줄. */
const STRONG_SEPARATOR = /[,;/|\n]+/;

/** 번호 안에 끼는 약한 구분자 — "002-1918-40078", "0021 9184 0078", "002.1918.40078". */
const WEAK_SEPARATOR = /[-\s.]/g;

export interface TraceCellResult {
  /** 읽어낸 번호들(대문자, 중복 제거, 적힌 순서). 없으면 빈 배열. */
  traceNos: string[];
  /** 과학표기로 잘려 복원 못 한 덩어리가 있었나. */
  truncated: boolean;
}

export interface TraceCellOptions {
  /**
   * 8~11자리 순수 숫자를 앞에 0을 채워 12자리로 볼지. 엑셀이 소 이력번호(항상 0으로
   * 시작)를 숫자로 다루면 앞의 0이 사라진 채 내보내지는데, 이력번호 칸이라고 확정된
   * 뒤에만 켠다 — 칸 추측 단계에서 켜면 금액 칸(예: 12500000)까지 이력번호로 오인한다.
   */
  allowZeroPad?: boolean;
}

/**
 * 과학표기를 정수 문자열로.
 *
 * 엑셀이 12자리 숫자를 일반 형식으로 내보내면 "1.40077E+11"처럼 유효숫자 6자리로 잘린다 —
 * 뒷자리 여섯이 사라진 것이라 복원할 수 없고, 만들어내면 안 된다(truncated로 알린다).
 * 반면 유효숫자가 거의 다 있는데 끝자리 한둘만 없는 건 진짜 번호가 0으로 끝나서
 * 과학표기가 그 0을 생략한 것이다("1.4007700015E+11" = 140077000150). 엑셀은 열한 자리까지
 * 남기고 한 자리만 자르는 식으로 잘라내지 않으므로, 빠진 자리가 두 자리 이하면 0을 채운다.
 */
const SCIENTIFIC_TRAILING_ZERO_TOLERANCE = 2;

function expandScientific(chunk: string): { digits: string | null; truncated: boolean } {
  const matched = chunk.match(SCIENTIFIC_PATTERN);

  if (!matched) return { digits: null, truncated: false };

  const mantissa = `${matched[1]}${matched[2] ?? ""}`.replace(/0+$/, "") || matched[1];
  const exponent = Number(matched[3]);
  const totalDigits = exponent + 1;
  const missing = totalDigits - mantissa.length;

  // 소수부가 남는다 — 정수가 아니니 이력번호가 아니다.
  if (missing < 0) return { digits: null, truncated: false };

  if (missing > SCIENTIFIC_TRAILING_ZERO_TOLERANCE) return { digits: null, truncated: true };

  return { digits: mantissa.padEnd(totalDigits, "0"), truncated: false };
}

/**
 * 명세서 칸 하나에서 이력/묶음번호를 **전부** 뽑는다.
 *
 * 스캐너가 주는 값과 달리 사람이 적거나 엑셀이 내보낸 칸은 형태가 흐트러진다:
 *   - 한 칸에 여러 번호("002191840078, 002191840079" — 소 여러 마리를 한 품목 줄로)
 *   - 하이픈·공백 구분("002-1918-40078")
 *   - 엑셀이 숫자로 다뤄 앞의 0이 사라짐("2191840078")·과학표기("1.4E+11")
 *   - 라벨이 같이 적힘("이력번호: 002191840078")
 * 바코드 원문·QR URL이 그대로 든 경우는 parseBarcode가 먼저 처리한다.
 */
export function parseTraceCell(raw: string, options: TraceCellOptions = {}): TraceCellResult {
  const value = (raw ?? "").trim();

  if (!value) return { traceNos: [], truncated: false };

  // 바코드 원문·URL은 그 안에서 번호 하나를 뽑는 게 정답이다(GS1 안의 숫자열을 번호로 오인하지 않게).
  // GS1은 구분문자나 괄호 AI 표기가 있을 때만 믿는다 — 소 이력번호는 "00…"으로 시작해 순수 숫자열만으로는
  // SSCC(AI 00)와 구분이 안 되고, 그러면 "002191840078, 002191840079"가 바코드로 오인된다.
  const barcode = parseBarcode(value);
  const explicitGs1 = value.includes("\u001d") || /^\(\d{2,4}\)/.test(value);

  if (barcode.format === "url" || (barcode.format === "gs1" && explicitGs1)) {
    return { traceNos: barcode.traceNo ? [barcode.traceNo] : [], truncated: false };
  }

  // 같은 번호가 두 번 적혀 있으면 두 번 그대로 둔다 — 같은 개체(소 한 마리)의 박스가 둘이라는 뜻이라
  // 줄도 둘로 나뉘어야 한다. 중복 제거는 하지 않는다.
  const found: string[] = [];
  let truncated = false;

  // 1) 정식 형태 그대로 적힌 번호를 전부 찾는다.
  for (const match of value.toUpperCase().matchAll(TRACE_TOKEN_PATTERN)) {
    found.push(match[1]);
  }

  if (found.length > 0) return { traceNos: found, truncated: false };

  // 2) 못 찾았으면 덩어리별로 흐트러진 형태를 되살린다.
  value.split(STRONG_SEPARATOR).forEach((chunk) => {
    const trimmed = chunk.trim();

    if (!trimmed) return;

    const scientific = expandScientific(trimmed);

    if (scientific.truncated) {
      truncated = true;
      return;
    }

    const compact = (scientific.digits ?? trimmed.toUpperCase()).replace(WEAK_SEPARATOR, "");
    const before = found.length;

    for (const match of compact.matchAll(TRACE_TOKEN_PATTERN)) {
      found.push(match[1]);
    }

    if (found.length > before) return;

    if (options.allowZeroPad && /^\d{8,11}$/.test(compact)) {
      found.push(compact.padStart(12, "0"));
    }
  });

  return { traceNos: found, truncated };
}

/** 이력번호 칸에 같이 적히는 라벨 낱말. 번호 외에 이것만 남으면 그 줄은 번호만 적은 부속 줄이다. */
const TRACE_LABEL_WORDS = /이력번호|이력|개체식별번호|개체번호|개체|묶음번호|묶음|로트번호|로트|lot\s*no|lot|trace\s*no|trace|no|번호/gi;

/**
 * 품목 줄 아래에 "이력번호: 002…"처럼 번호만 따로 적은 부속 줄인지. 칸이 어긋나
 * 있어도(첫 칸에 번호가 오는 경우가 흔함) 줄 전체를 보고 판정한다.
 * 그런 줄은 위 품목 줄에 붙인다 — 별도 품목으로 넣으면 "품목명 없는 줄"이 되고,
 * 위 줄은 번호 없는 줄이 된다.
 */
function traceOnlyRow(row: string[]): string[] | null {
  const joined = row.join(" ").trim();

  if (!joined) return null;

  const { traceNos } = parseTraceCell(joined, { allowZeroPad: false });

  if (traceNos.length === 0) return null;

  // 하이픈·공백으로 쪼개 적힌 번호도 지워지도록 약한 구분자를 뺀 형태에서 번호를 걷어낸다.
  // 중량("8.20")처럼 다른 값이 있으면 숫자가 남아 부속 줄로 보지 않는다.
  let rest = joined.toUpperCase().replace(WEAK_SEPARATOR, "");

  traceNos.forEach((traceNo) => {
    rest = rest.split(traceNo).join("");
  });

  rest = rest.replace(TRACE_LABEL_WORDS, "").replace(/[:：|,;/()_]/g, "");

  return rest === "" ? traceNos : null;
}

/** 값 대부분이 개체(12자리)인지 묶음(L+14/15자리)인지 — 두 칸이 같이 올 때 어느 쪽이 어느 칸인지 가르는 기준. */
function majorityTraceKind(values: string[]): "individual" | "group" | null {
  let individual = 0;
  let group = 0;

  values.forEach((value) => {
    parseTraceCell(value).traceNos.forEach((traceNo) => {
      if (/^\d{12}$/.test(traceNo)) individual += 1;
      else group += 1;
    });
  });

  if (individual === 0 && group === 0) return null;

  return individual >= group ? "individual" : "group";
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
      /** 이력번호로 읽히는 칸인지 (하이픈·공백 구분·여러 개 나열도 인정, 0 탈락 복원은 여기선 안 함) */
      traceHits: values.filter((v) => parseTraceCell(v).traceNos.length > 0).length,
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

  // 이력번호: 대부분의 값이 이력번호로 읽히는 칸. 그런 칸이 여러 개면 12자리 축종코드(첫 자리
  // 소0·돼지1·닭2·계란3·오리5)까지 맞는 값이 더 많은 칸을 고른다 — 12자리 숫자는 그 밖에도 흔해서
  // (금액·코드 열) 칸 순서만으로 고르면 엉뚱한 칸을 이력번호로 잡을 수 있다. 동률이면 앞쪽 칸.
  const traceCandidates = stats
    .filter((s) => s.values.length > 0 && s.traceHits / s.values.length >= 0.6)
    .map((s) => ({
      column: s.column,
      kind: majorityTraceKind(s.values),
      structured: s.values.filter((v) => parseTraceCell(v).traceNos.some((t) => parseTraceNumber(t) !== null)).length,
    }))
    .sort((a, b) => b.structured - a.structured || a.column - b.column);

  claim("traceNo", traceCandidates[0]?.column);

  // 묶음번호 칸: 이력번호 칸과 **종류가 다른**(개체 ↔ 묶음) 번호 칸이 하나 더 있으면 그 칸이다.
  // 같은 종류의 번호 칸이 둘이면(코드 열 등) 어느 게 뭔지 모르니 사람에게 맡긴다.
  const traceColumn = map.traceNo;

  if (traceColumn !== undefined) {
    const traceKind =
      traceCandidates.find((c) => c.column === traceColumn)?.kind ??
      majorityTraceKind(bodyRows.map((row) => (row[traceColumn] ?? "").trim()).filter(Boolean));
    const other = traceCandidates.find(
      (c) => c.column !== traceColumn && !taken.has(c.column) && c.kind !== null && c.kind !== traceKind,
    );

    claim("lotNo", other?.column);
  }

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

  // 묶음번호 칸만 있고 이력번호 칸이 없는 명세서(로트 단위 거래)는 그 칸이 곧 번호 칸이다 —
  // 로트를 이력번호와 같은 재고 단위로 보는 잠긴 결정 그대로. lotNo는 두 칸이 나란히 올 때만 남는다.
  if (headerMap.lotNo !== undefined && headerMap.traceNo === undefined) {
    headerMap.traceNo = headerMap.lotNo;
    delete headerMap.lotNo;
  }

  const columnMap = mapByContent(bodyRows, headerMap);

  // 두 칸이 뒤바뀐 서식(묶음번호 칸에 12자리, 이력번호 칸에 L…)은 내용을 보고 바로잡는다.
  if (columnMap.traceNo !== undefined && columnMap.lotNo !== undefined) {
    const kindOf = (column: number) =>
      majorityTraceKind(bodyRows.map((row) => (row[column] ?? "").trim()).filter(Boolean));

    if (kindOf(columnMap.traceNo) === "group" && kindOf(columnMap.lotNo) === "individual") {
      [columnMap.traceNo, columnMap.lotNo] = [columnMap.lotNo, columnMap.traceNo];
    }
  }

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
  const headerRowIndex =
    options.headerRowIndex !== undefined ? options.headerRowIndex : grid.headerRowIndex;
  const excluded = new Set([...grid.totalRowIndexes, ...(options.excludeRowIndexes ?? [])]);

  // 1차: 줄마다 값을 읽되 이력번호는 여러 개일 수 있으니 배열로 모아둔다.
  //       번호만 적힌 부속 줄은 바로 위 품목 줄에 합친다.
  interface Draft extends Omit<DocumentLine, "lineNo" | "traceNo" | "splitOf"> {
    traceNos: string[];
  }

  const drafts: Draft[] = [];

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

    // 번호만 따로 적은 부속 줄("이력번호: 002…")은 위 품목 줄의 번호다. 위 줄이 없으면 그냥 한 줄로 둔다.
    const attachable = traceOnlyRow(row);
    const previous = drafts[drafts.length - 1];
    // 위 줄도 번호만 있는 줄이면 이 문서는 번호 목록이다 — 합치지 않고 줄대로 둔다.
    const previousIsItem =
      previous !== undefined &&
      (previous.itemName !== null || previous.labeledWeight !== null || previous.amount !== null);

    if (attachable && previous && previousIsItem) {
      attachable.forEach((traceNo) => {
        if (!previous.traceNos.includes(traceNo)) previous.traceNos.push(traceNo);
      });
      previous.raw = `${previous.raw}\n${row.join(" | ")}`;
      return;
    }

    // 셀에 바코드 원문·URL이 그대로 들어있거나, 여러 번호·하이픈·0 탈락·과학표기로 흐트러진 경우까지 한 번 태운다.
    const traceCell = parseTraceCell(pick("traceNo"), { allowZeroPad: true });
    // 정식 형태로 못 읽었지만 뭔가 적혀 있으면 원문을 그대로 남긴다 — 사람이 보고 고친다(과학표기로 잘린 건 제외: 그 값은 번호가 아니다).
    const rawTrace = pick("traceNo");
    const traceNos =
      traceCell.traceNos.length > 0 ? traceCell.traceNos : rawTrace && !traceCell.truncated ? [rawTrace] : [];
    const lotCell = parseTraceCell(pick("lotNo"), { allowZeroPad: false });
    const rawLot = pick("lotNo");
    const lotNo = lotCell.traceNos[0] ?? (rawLot || null);
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
    if (!itemName && traceNos.length === 0 && !lotNo && labeledWeight === null && amount === null && !traceCell.truncated) {
      return;
    }

    drafts.push({
      raw: row.join(" | "),
      itemName,
      traceNos,
      lotNo,
      traceTruncated: traceCell.truncated,
      partName,
      grade,
      origin,
      quantity,
      labeledWeight,
      unitPrice,
      amount,
    });
  });

  // 2차: 번호가 여럿인 줄은 번호마다 한 줄로. 중량·수량·금액은 첫 줄에 원문 그대로 두고
  //       나머지는 비운다(DocumentLine.splitOf 주석 참고). 단가는 전 줄에 복사한다.
  const lines: DocumentLine[] = [];

  drafts.forEach((draft) => {
    const { traceNos, ...rest } = draft;
    const count = Math.max(traceNos.length, 1);

    for (let index = 0; index < count; index += 1) {
      const first = index === 0;

      lines.push({
        ...rest,
        lineNo: lines.length + 1,
        raw: count > 1 ? `${draft.raw} (이력번호 ${index + 1}/${count})` : draft.raw,
        traceNo: traceNos[index] ?? null,
        quantity: first ? draft.quantity : null,
        labeledWeight: first ? draft.labeledWeight : null,
        amount: first ? draft.amount : null,
        splitOf: count > 1 ? { index, count } : null,
      });
    }
  });

  return lines;
}
