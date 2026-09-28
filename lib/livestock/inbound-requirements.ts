import { normalizeImportedOrigin } from "@/lib/products/origin-options";
/**
 * 입고 한 건이 플랫폼 기준을 채웠는지 판정한다 (29단계 B).
 *
 * 값이 들어오는 길이 둘이라 둘을 다 참조한다(사장님 지침):
 *   - 스캔 자체        — 이력번호, 저울 실중량, 바코드 표기중량
 *   - 공공 이력조회    — 등급, 원산지, 도축일
 *
 * 그래서 결과는 "빠진 것 목록"이 아니라 **항목마다 값과 출처를 같이 보여주는
 * 체크리스트**다.
 */

export type FieldSource =
  /** 찍을 때 들어온 값 (이력번호, 저울 실중량, 바코드 표기중량) */
  | "SCAN"
  /** 공공 이력조회가 채운 값 */
  | "TRACE_API"
  /** 연결된 상품이 가진 값 */
  | "PRODUCT";

export type FieldLevel = "REQUIRED" | "RECOMMENDED";

export interface ScanFieldStatus {
  key: string;
  label: string;
  level: FieldLevel;
  /** 채워진 값. null이면 아직 비어 있다. */
  value: string | null;
  /** 그 값이 어디서 왔는지. 비어 있으면 null. */
  source: FieldSource | null;
  /** 비어 있을 때 무엇을 하면 되는지 — 한 줄로 그대로 띄운다. */
  hint: string | null;
}

export interface ScanFacts {
  traceNo: string | null;
  productId: string | null;
  productName?: string | null;
  productOrigin?: string | null;
  /** 저울 실중량 */
  weight: number | null;
  /** 바코드에 적힌 표기중량 */
  labeledWeight: number | null;
  purchaseUnitPrice: number | null;
  purchaseSupplier: string | null;

  /** 공공 이력조회가 이 번호를 찾았는지 */
  traceFound: boolean;
  apiSpecies?: string | null;
  apiGrade?: string | null;
  apiOrigin?: string | null;
}

export interface ScanRequirementReport {
  fields: ScanFieldStatus[];
  /** 아직 비어 있는 필수 항목 수 */
  missingRequired: number;
}

function pick(
  candidates: Array<{ value: string | null | undefined; source: FieldSource }>,
): { value: string | null; source: FieldSource | null } {
  for (const candidate of candidates) {
    const text = candidate.value === null || candidate.value === undefined ? "" : String(candidate.value).trim();

    if (text) return { value: text, source: candidate.source };
  }

  return { value: null, source: null };
}

function formatWeight(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : `${value}kg`;
}

function formatMoney(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : `${Math.round(value).toLocaleString()}원`;
}

/**
 * 이력조회 결과에서 원산지를 정한다.
 *
 * 국내 축산물이력제(mtrace)는 **원산지 필드를 아예 주지 않는다** — 실제 적재된
 * 레코드에서 `origin_country`가 비어 있는 것을 확인했다. 줄 이유가 없어서다:
 * 그 시스템 자체가 국내에서 사육·도축된 가축만 다루고, 수입육은 운영기관이
 * 다른 별도 시스템(meatwatch)으로 간다. 즉 **국내 이력제에 번호가 있다는 것
 * 자체가 국내산이라는 뜻**이다. 수입 생우를 국내에서 도축한 '육우'도 원산지
 * 표시는 국내산이므로 이 판정은 그대로 성립한다.
 *
 * 원산지는 허위표시가 법적 문제로 직결되므로, 값을 받아 적는 게 아니라 이렇게
 * 근거를 한 곳에 적어두고 판정한다.
 */
export function resolveTraceOrigin(
  source: string | null | undefined,
  originCountry: string | null | undefined,
): string | null {
  const explicit = (originCountry ?? "").trim();

  // API가 명시적으로 준 값이 있으면 그게 우선이다(수입 쪽은 국가명이 온다) — 원산지 목록의 값으로 옮기고 목록 밖 나라는 '기타 수입산'.
  if (explicit) return /국내|한국/.test(explicit) ? "국내산" : normalizeImportedOrigin(explicit);

  return (source ?? "").startsWith("mtrace_livestock") ? "국내산" : null;
}

export function buildScanRequirementReport(facts: ScanFacts): ScanRequirementReport {
  const fields: ScanFieldStatus[] = [];

  const add = (field: ScanFieldStatus) => fields.push(field);

  // 이력번호 — 스캔하면 항상 있다. 축산물이력법상 거래내역에 남아야 하는 값이라
  // 체크리스트에 그대로 둔다(없는 경우는 수기 등록뿐이다).
  add({
    key: "traceNo",
    label: "이력번호",
    level: "REQUIRED",
    value: facts.traceNo ?? null,
    source: facts.traceNo ? "SCAN" : null,
    hint: facts.traceNo ? null : "바코드를 다시 찍어주세요.",
  });

  // 축종 — 상품을 고르기 전에 뭘 고르는 건지부터 알아야 한다(사장님 지적:
  // 이력조회가 부위를 안 주는 경우가 많아 축종이라도 화면에서 바로 보여야
  // 드롭다운에서 엉뚱한 걸 고르지 않는다). 이력조회로만 채워진다 — 스캔엔 축종 필드 자체가 없다.
  add({
    key: "species",
    label: "축종",
    level: "RECOMMENDED",
    value: facts.apiSpecies ?? null,
    source: facts.apiSpecies ? "TRACE_API" : null,
    hint: facts.apiSpecies
      ? null
      : facts.traceFound
        ? "이력조회에 축종 정보가 없습니다."
        : "이력조회가 이 번호를 찾지 못했습니다.",
  });

  add({
    key: "product",
    label: "상품",
    level: "REQUIRED",
    value: facts.productName ?? (facts.productId ? "연결됨" : null),
    source: facts.productId ? "SCAN" : null,
    hint: facts.productId ? null : "이 박스가 어느 상품인지 골라주세요.",
  });

  add({
    key: "weight",
    label: "실중량",
    level: "REQUIRED",
    value: formatWeight(facts.weight),
    source: facts.weight === null ? null : "SCAN",
    hint: facts.weight === null ? "저울에 찍힌 무게를 입력해주세요." : null,
  });

  // 표기중량 — 바코드에 실려 오면 채워진다. 실중량과 대조해 모자라게 온 걸 잡는 값이라 필수로 본다.
  add({
    key: "labeledWeight",
    label: "표기중량",
    level: "REQUIRED",
    value: formatWeight(facts.labeledWeight),
    source: facts.labeledWeight === null ? null : "SCAN",
    hint: facts.labeledWeight === null ? "바코드에 중량이 없습니다." : null,
  });

  add({
    key: "supplier",
    label: "공급처",
    level: "REQUIRED",
    value: facts.purchaseSupplier ?? null,
    source: facts.purchaseSupplier ? "SCAN" : null,
    hint: facts.purchaseSupplier ? null : "지금 온 거래처를 골라주세요.",
  });

  add({
    key: "unitPrice",
    label: "매입단가",
    level: "REQUIRED",
    value: formatMoney(facts.purchaseUnitPrice),
    source: facts.purchaseUnitPrice === null ? null : "SCAN",
    hint: facts.purchaseUnitPrice === null ? "매입단가를 입력해주세요." : null,
  });

  // 등급 — 공공조회로만 채워진다.
  add({
    key: "grade",
    label: "등급",
    level: "RECOMMENDED",
    value: facts.apiGrade ?? null,
    source: facts.apiGrade ? "TRACE_API" : null,
    hint: facts.apiGrade
      ? null
      : facts.traceFound
        ? "이력조회에 등급이 없습니다."
        : "이력조회가 이 번호를 찾지 못했습니다.",
  });

  // 원산지 — 필수. 공공조회 > 연결된 상품 순으로 본다.
  const origin = pick([
    { value: facts.apiOrigin, source: "TRACE_API" },
    { value: facts.productOrigin, source: "PRODUCT" },
  ]);

  add({
    key: "origin",
    label: "원산지",
    level: "REQUIRED",
    value: origin.value,
    source: origin.source,
    hint: origin.value ? null : "이력조회·상품 어디에도 원산지가 없습니다.",
  });

  return {
    fields,
    missingRequired: fields.filter((field) => field.level === "REQUIRED" && !field.value).length,
  };
}
