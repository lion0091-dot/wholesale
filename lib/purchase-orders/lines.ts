/**
 * 공급처 발주서 줄 — 화면 입력, 엑셀 올리기, 서버 저장이 같은 검증을 쓴다.
 *
 * 줄은 상품 ID가 아니라 스펙(축종·부위·등급·원산지)과 수량(kg)이다. 처음 취급하는 품목은 상품이 아직 없을 수 있고
 * 이력 조회로 상품이 자동 생성되는 축종은 발주 시점에 상품이 없을 수 있기 때문이다(마이그레이션 135).
 */

import { CATTLE_GRADES, ORIGIN_OPTIONS, specListRuleFor } from "./spec-options";

export const PURCHASE_ORDER_SHEET = "발주서";
export const PURCHASE_ORDER_HEADERS = ["축종", "부위", "등급", "원산지", "수량(kg)", "단가(원/kg)"] as const;
export const PURCHASE_ORDER_MAX_LINES = 300;

export interface PurchaseOrderLineInput {
  category: string;
  subcategory: string;
  grade: string;
  origin: string;
  quantity: string;
  unitPrice: string;
}

export interface ValidatedLine {
  category: string;
  subcategory: string | null;
  grade: string | null;
  origin: string;
  quantity: number;
  unitPrice: number | null;
}

export type LineValidation = { ok: true; line: ValidatedLine } | { ok: false; error: string };

/** "1,200", "50kg", "68,000원" 같은 표기를 숫자로 바꾼다. 숫자가 아니면 null. */
export function parseAmount(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, "").replace(/(kg|KG|원)$/, "");

  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }

  const parsed = Number.parseFloat(cleaned);

  return Number.isFinite(parsed) ? parsed : null;
}

export function validatePurchaseOrderLine(
  input: PurchaseOrderLineInput,
  categories: readonly string[],
  subcategoriesByCategory: Readonly<Record<string, readonly string[]>> = {}
): LineValidation {
  const category = input.category.trim();
  const origin = input.origin.trim();
  const subcategory = input.subcategory.trim();
  const grade = input.grade.trim();

  if (!category) {
    return { ok: false, error: "축종을 골라주세요." };
  }

  if (!categories.includes(category)) {
    return { ok: false, error: `축종 '${category}'을(를) 알 수 없습니다. (${categories.join(", ")} 중 하나)` };
  }

  if (!origin) {
    return { ok: false, error: "원산지를 입력해주세요." };
  }

  const rule = specListRuleFor(category);
  const parts = subcategoriesByCategory[category] ?? [];

  if (rule.partFromList && subcategory && parts.length > 0 && !parts.includes(subcategory)) {
    return { ok: false, error: `${category}의 부위 '${subcategory}'은(는) 목록에 없습니다. 목록에서 골라주세요.` };
  }

  if (rule.gradeFromList && grade && !CATTLE_GRADES.includes(grade)) {
    return { ok: false, error: `등급 '${grade}'은(는) 목록에 없습니다. (${CATTLE_GRADES.join(", ")} 중 하나)` };
  }

  if (rule.originFromList && !ORIGIN_OPTIONS.includes(origin)) {
    return { ok: false, error: `원산지 '${origin}'은(는) 목록에 없습니다. (${ORIGIN_OPTIONS.join(", ")} 중 하나)` };
  }

  const quantity = parseAmount(input.quantity);

  if (quantity === null || quantity <= 0) {
    return { ok: false, error: "수량(kg)은 0보다 큰 숫자여야 합니다." };
  }

  if (quantity > 99999999) {
    return { ok: false, error: "수량이 너무 큽니다." };
  }

  const priceText = input.unitPrice.trim();
  const unitPrice = priceText ? parseAmount(priceText) : null;

  if (priceText && unitPrice === null) {
    return { ok: false, error: "단가는 0 이상의 숫자여야 합니다." };
  }

  return {
    ok: true,
    line: {
      category,
      subcategory: subcategory || null,
      grade: grade || null,
      origin,
      quantity,
      unitPrice,
    },
  };
}

export interface ParsedUploadRow {
  rowNo: number;
  input: PurchaseOrderLineInput;
  error: string | null;
}

export interface ParsedUpload {
  rows: ParsedUploadRow[];
  /** 머리글을 못 찾았을 때만 채워진다 — 이때 rows는 비어 있다. */
  headerError: string | null;
}

const compact = (text: string) => text.replace(/\s/g, "").replace(/\(.*?\)/g, "");

const HEADER_KEYS: Array<{ key: keyof PurchaseOrderLineInput; names: string[] }> = [
  { key: "category", names: ["축종", "카테고리"] },
  { key: "subcategory", names: ["부위"] },
  { key: "grade", names: ["등급"] },
  { key: "origin", names: ["원산지"] },
  { key: "quantity", names: ["수량", "중량", "kg"] },
  { key: "unitPrice", names: ["단가"] },
];

/** 엑셀 격자에서 발주서 줄을 읽는다. 머리글은 위쪽 5줄 안에서 축종·수량 칸이 있는 줄을 찾고, 칸 순서는 이름으로 찾는다. */
export function parsePurchaseOrderCells(
  cells: string[][],
  categories: readonly string[],
  subcategoriesByCategory: Readonly<Record<string, readonly string[]>> = {}
): ParsedUpload {
  const headerIndex = cells.slice(0, 5).findIndex((row) => {
    const names = row.map(compact);

    return names.includes("축종") && names.some((name) => HEADER_KEYS[4].names.includes(name));
  });

  if (headerIndex === -1) {
    return {
      rows: [],
      headerError: "머리글(축종·부위·등급·원산지·수량·단가)을 찾지 못했습니다. 내려받은 양식을 그대로 쓰세요.",
    };
  }

  const columnOf = new Map<keyof PurchaseOrderLineInput, number>();

  cells[headerIndex].forEach((cell, index) => {
    const name = compact(cell);
    const matched = HEADER_KEYS.find((entry) => entry.names.includes(name));

    if (matched && !columnOf.has(matched.key)) {
      columnOf.set(matched.key, index);
    }
  });

  const rows: ParsedUploadRow[] = [];

  cells.slice(headerIndex + 1).forEach((row, offset) => {
    const pick = (key: keyof PurchaseOrderLineInput) => {
      const column = columnOf.get(key);

      return column === undefined ? "" : (row[column] ?? "").trim();
    };
    const input: PurchaseOrderLineInput = {
      category: pick("category"),
      subcategory: pick("subcategory"),
      grade: pick("grade"),
      origin: pick("origin"),
      quantity: pick("quantity"),
      unitPrice: pick("unitPrice"),
    };

    if (Object.values(input).every((value) => value === "")) {
      return;
    }

    const validation = validatePurchaseOrderLine(input, categories, subcategoriesByCategory);

    rows.push({ rowNo: headerIndex + offset + 2, input, error: validation.ok ? null : validation.error });
  });

  return { rows, headerError: null };
}
