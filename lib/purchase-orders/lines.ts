/**
 * 공급처 발주서 줄 — 화면 입력, 엑셀 올리기, 서버 저장이 같은 검증을 쓴다.
 *
 * 줄은 상품 ID가 아니라 스펙(축종·품종·부위·등급·원산지)과 수량(kg)이다. 처음 취급하는 품목은 상품이 아직 없을 수 있고
 * 이력 조회로 상품이 자동 생성되는 축종은 발주 시점에 상품이 없을 수 있기 때문이다(마이그레이션 135).
 */

import { CATTLE_BREEDS, CATTLE_GRADES, CATTLE_SEXES, BMS_VALUES, STORAGE_STATES, ORIGIN_OPTIONS, bmsAppliesTo, specListRuleFor } from "./spec-options";
import { identityFieldsFor } from "@/lib/products/identity-key";
import { isDomesticOrigin } from "@/lib/products/origin-options";

export const PURCHASE_ORDER_SHEET = "전표";
export const PURCHASE_ORDER_HEADERS = ["축종", "품종", "부위", "등급", "성별", "원산지", "냉장/냉동", "BMS", "수량(kg)", "단가(원/kg)"] as const;
export const PURCHASE_ORDER_MAX_LINES = 300;

export interface PurchaseOrderLineInput {
  category: string;
  /** 소만 — 한우·육우·젖소. 다른 축종은 빈 문자열. */
  breed: string;
  subcategory: string;
  grade: string;
  /** 소만 — 거세·암. 다른 축종은 빈 문자열. */
  sex: string;
  /** 소 1++ 등급만 — 7·8·9. 그 밖엔 빈 문자열(항상 선택). */
  bms: string;
  /** 소·돼지·닭·오리 — 냉장·냉동. 계란·그 밖의 축종은 빈 문자열. */
  storageState: string;
  origin: string;
  quantity: string;
  unitPrice: string;
  /** 고른 상품 ID — 비어 있으면 연결된 상품이 없는 줄(스펙만). */
  productId?: string;
}

export interface ValidatedLine {
  category: string;
  breed: string | null;
  subcategory: string | null;
  grade: string | null;
  sex: string | null;
  bms: string | null;
  storageState: string | null;
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
  subcategoriesByCategory: Readonly<Record<string, readonly string[]>> = {},
  /** 등록된 상품에서 온 스펙이면 목록 검사를 건너뛴다 — 상품 값은 이미 등록 때 검사했고 예전에 등록된 값은 목록 밖일 수 있다. */
  options: { trustSpec?: boolean } = {}
): LineValidation {
  const category = input.category.trim();
  const origin = input.origin.trim();
  const subcategory = input.subcategory.trim();
  const grade = input.grade.trim();
  const breed = input.breed.trim();
  const sex = input.sex.trim();
  const storageState = input.storageState.trim();
  const bms = input.bms.trim();

  if (!category) {
    return { ok: false, error: "축종을 골라주세요." };
  }

  if (!categories.includes(category)) {
    return { ok: false, error: `축종 '${category}'을(를) 알 수 없습니다. (${categories.join(", ")} 중 하나)` };
  }

  if (!origin) {
    return { ok: false, error: "원산지를 입력해주세요." };
  }

  const isCattle = category === "소";
  const usesStorage = identityFieldsFor(category)?.includes("storageState") ?? false;

  // 품종·성별은 국내산 소에만 있는 개념(수입육 이력 API에 그 값 자체가 없다, 2026-09-28/09-30 확인) — 수입 원산지는 비워도 된다.
  if (isCattle && isDomesticOrigin(origin)) {
    if (!breed) {
      return {
        ok: false,
        error: options.trustSpec
          ? "이 상품은 품종이 비어 있어 발주에 쓸 수 없습니다. 상품 관리에서 품종을 채워주세요."
          : "품종을 골라주세요. (한우, 육우, 젖소)",
      };
    }

    if (!CATTLE_BREEDS.includes(breed)) {
      return { ok: false, error: `품종 '${breed}'은(는) 목록에 없습니다. (${CATTLE_BREEDS.join(", ")} 중 하나)` };
    }

    if (!sex) {
      return {
        ok: false,
        error: options.trustSpec
          ? "이 상품은 성별이 비어 있어 발주에 쓸 수 없습니다. 상품 관리에서 성별을 채워주세요."
          : "성별을 골라주세요. (거세, 암)",
      };
    }

    if (!CATTLE_SEXES.includes(sex)) {
      return { ok: false, error: `성별 '${sex}'은(는) 목록에 없습니다. (${CATTLE_SEXES.join(", ")} 중 하나)` };
    }
  }

  // 냉장/냉동은 원산지와 무관하게 항상 필요하다(수입육도 표기가 있다) — 상품 정체성 키.
  if (usesStorage) {
    if (!storageState) {
      return {
        ok: false,
        error: options.trustSpec
          ? "이 상품은 냉장/냉동이 비어 있어 발주에 쓸 수 없습니다. 상품 관리에서 냉장/냉동을 채워주세요."
          : "냉장/냉동을 골라주세요. (냉장, 냉동)",
      };
    }

    if (!STORAGE_STATES.includes(storageState)) {
      return { ok: false, error: `냉장/냉동 '${storageState}'은(는) 목록에 없습니다. (${STORAGE_STATES.join(", ")} 중 하나)` };
    }
  }

  if (bms && bmsAppliesTo(category, grade) && !BMS_VALUES.includes(bms)) {
    return { ok: false, error: `BMS '${bms}'은(는) 목록에 없습니다. (${BMS_VALUES.join(", ")} 중 하나)` };
  }

  const rule = options.trustSpec ? specListRuleFor(null) : specListRuleFor(category);
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
      breed: isCattle ? breed || null : null,
      subcategory: subcategory || null,
      grade: grade || null,
      sex: isCattle ? sex || null : null,
      bms: bmsAppliesTo(category, grade) ? bms || null : null,
      storageState: usesStorage ? storageState || null : null,
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
  { key: "breed", names: ["품종"] },
  { key: "subcategory", names: ["부위"] },
  { key: "grade", names: ["등급"] },
  { key: "sex", names: ["성별"] },
  { key: "origin", names: ["원산지"] },
  { key: "storageState", names: ["냉장/냉동", "냉장냉동"] },
  { key: "bms", names: ["BMS", "bms"] },
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

    return names.includes("축종") && names.some((name) => HEADER_KEYS.find((entry) => entry.key === "quantity")?.names.includes(name));
  });

  if (headerIndex === -1) {
    return {
      rows: [],
      headerError: "머리글(축종·품종·부위·등급·성별·원산지·냉장/냉동·BMS·수량·단가)을 찾지 못했습니다. 내려받은 양식을 그대로 쓰세요.",
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
      breed: pick("breed"),
      subcategory: pick("subcategory"),
      grade: pick("grade"),
      sex: pick("sex"),
      bms: pick("bms"),
      storageState: pick("storageState"),
      origin: pick("origin"),
      quantity: pick("quantity"),
      unitPrice: pick("unitPrice"),
      productId: "",
    };

    if (Object.values(input).every((value) => !value)) {
      return;
    }

    const validation = validatePurchaseOrderLine(input, categories, subcategoriesByCategory);

    rows.push({ rowNo: headerIndex + offset + 2, input, error: validation.ok ? null : validation.error });
  });

  return { rows, headerError: null };
}
