/**
 * 판매가 일괄 등록용 CSV 만들기/읽기.
 *
 * 흐름: 상품관리에서 내려받기 → 엑셀에서 "판매가" 칸 채우기 → 다시 올리기.
 *
 * 상품 식별은 UUID로만 한다. 이름으로 맞추면 같은 이름이 둘이거나 엑셀에서
 * 이름을 고친 순간 엉뚱한 상품 가격이 바뀐다.
 */

/** 내려받는 CSV의 칸 순서. 읽을 때는 이름으로 찾으므로 순서가 바뀌어도 된다. */
export const PRICE_CSV_HEADERS = [
  "상품ID",
  "상품명",
  "축종",
  "부위",
  "등급",
  "단위",
  "현재판매가",
  "공공시세",
  "판매가",
] as const;

export interface PriceCsvProduct {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  grade: string | null;
  unit: string;
  basePrice: number;
  /** 참고용 공공 경락가 (없으면 null) */
  marketPrice: number | null;
}

export interface PriceUpdateRow {
  rowNo: number;
  id: string;
  /** 사용자가 적어 넣은 판매가. 비어 있으면 null(=건너뜀) */
  price: number | null;
  name: string;
  error: string | null;
}

export interface ParsedPriceCsv {
  rows: PriceUpdateRow[];
  /** 실제로 값이 채워진 줄 수 */
  filledCount: number;
  errorCount: number;
}

/** 쉼표·따옴표·줄바꿈이 든 값을 CSV 규칙대로 감싼다. */
function escapeCell(value: string | number | null): string {
  const text = value === null || value === undefined ? "" : String(value);

  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildPriceCsv(products: PriceCsvProduct[]): string {
  const lines = [PRICE_CSV_HEADERS.join(",")];

  for (const product of products) {
    lines.push(
      [
        product.id,
        product.name,
        product.category,
        product.subcategory ?? "",
        product.grade ?? "",
        product.unit,
        product.basePrice,
        product.marketPrice ?? "",
        // 사용자가 채울 칸 — 비워서 내보낸다.
        "",
      ]
        .map(escapeCell)
        .join(",")
    );
  }

  // 엑셀이 UTF-8로 열도록 BOM을 붙인다. 없으면 한글이 깨져 보인다.
  return `﻿${lines.join("\n")}\n`;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);

  return cells.map((cell) => cell.trim());
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "68,000", "68000원" 같은 표기를 숫자로 바꾼다. */
function parsePrice(value: string): number | null {
  const cleaned = value.replace(/[^\d.]/g, "");

  if (!cleaned) return null;

  const parsed = Number.parseFloat(cleaned);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parsePriceCsv(text: string): ParsedPriceCsv {
  const lines = text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return { rows: [], filledCount: 0, errorCount: 0 };
  }

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const header = splitCsvLine(lines[0], delimiter);

  // 칸 순서가 바뀌거나 사용자가 열을 추가해도 되게 이름으로 찾는다.
  const idIndex = header.findIndex((cell) => cell.replace(/\s/g, "") === "상품ID");
  const priceIndex = header.findIndex((cell) => cell.replace(/\s/g, "") === "판매가");
  const nameIndex = header.findIndex((cell) => cell.replace(/\s/g, "") === "상품명");

  if (idIndex === -1 || priceIndex === -1) {
    return {
      rows: [
        {
          rowNo: 1,
          id: "",
          price: null,
          name: "",
          error: "머리글에 '상품ID'와 '판매가' 칸이 있어야 합니다. 내려받은 파일을 그대로 쓰세요.",
        },
      ],
      filledCount: 0,
      errorCount: 1,
    };
  }

  const rows: PriceUpdateRow[] = [];

  lines.slice(1).forEach((line, index) => {
    const cells = splitCsvLine(line, delimiter);
    const id = cells[idIndex] ?? "";
    const name = nameIndex >= 0 ? cells[nameIndex] ?? "" : "";
    const price = parsePrice(cells[priceIndex] ?? "");

    rows.push({
      rowNo: index + 2,
      id,
      price,
      name,
      error: UUID_PATTERN.test(id) ? null : "상품ID가 올바르지 않습니다",
    });
  });

  return {
    rows,
    filledCount: rows.filter((row) => !row.error && row.price !== null).length,
    errorCount: rows.filter((row) => row.error).length,
  };
}
