/**
 * 입고 한 건이 플랫폼 기준을 채웠는지 판정한다 (29단계 B).
 *
 * 명세서 쪽 판정(document-requirements.ts)과 짝이다. 그쪽은 "서류 한 줄에 뭐가
 * 빠졌나"를 보고, 이쪽은 **실제로 찍은 박스 한 개**를 보고 같은 기준으로 본다.
 *
 * 값이 들어오는 길이 셋이라 셋을 다 참조한다(사장님 지침):
 *   - 스캔 자체        — 이력번호, 저울 실중량, 바코드 표기중량
 *   - 공공 이력조회    — 등급, 원산지, 도축일
 *   - 올라온 명세서    — 표기중량, 단가, 공급처, 등급, 원산지
 *
 * 그래서 결과는 "빠진 것 목록"이 아니라 **항목마다 값과 출처를 같이 보여주는
 * 체크리스트**다. 빠진 항목만 보여주면 "이 값이 어디서 온 건지"를 알 수 없고,
 * 공공조회 값과 명세서 값이 어긋날 때 그걸 드러낼 수도 없다.
 *
 * 순서는 가정하지 않는다 — 명세서가 먼저 올라왔든 스캔이 먼저든 같은 결과가
 * 나와야 한다(잠긴 결정).
 */

export type FieldSource =
  /** 찍을 때 들어온 값 (이력번호, 저울 실중량, 바코드 표기중량) */
  | "SCAN"
  /** 공공 이력조회가 채운 값 */
  | "TRACE_API"
  /** 올라온 명세서에서 온 값 */
  | "DOCUMENT"
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
  /**
   * 공공조회 값과 명세서 값이 서로 다를 때 채운다.
   * 어느 한쪽이 틀렸다는 뜻이라 사람이 봐야 한다.
   */
  conflict: string | null;
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

  /** 같은 이력번호의 명세서 줄을 찾았는지 */
  documentMatched: boolean;
  documentSupplier?: string | null;
  /** 명세서에 공급처가 적은 품목명 원문. 이력조회가 부위를 안 줘도 이게 부위를 말해준다. */
  documentItemName?: string | null;
  documentGrade?: string | null;
  documentOrigin?: string | null;
  documentUnitPrice?: number | null;
  documentLabeledWeight?: number | null;
}

export interface ScanRequirementReport {
  fields: ScanFieldStatus[];
  /** 아직 비어 있는 필수 항목 수 */
  missingRequired: number;
  /** 공공조회와 명세서가 어긋난 항목 수 */
  conflictCount: number;
  /** 명세서가 붙었는지 — 화면에서 "명세서 연결 안 됨"을 띄우는 근거 */
  documentMatched: boolean;
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

/** 공공조회와 명세서가 같은 항목을 다르게 말하면 그대로 드러낸다. */
function conflictOf(
  apiValue: string | null | undefined,
  documentValue: string | null | undefined,
  label: string,
): string | null {
  const a = (apiValue ?? "").trim();
  const d = (documentValue ?? "").trim();

  if (!a || !d || a === d) return null;

  return `${label}: 이력조회 ${a} / 명세서 ${d}`;
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

  // API가 명시적으로 준 값이 있으면 그게 우선이다(수입 쪽은 국가명이 온다).
  if (explicit) return explicit;

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
    conflict: null,
  });

  // 축종 — 상품을 고르기 전에 뭘 고르는 건지부터 알아야 한다(사장님 지적:
  // 이력조회가 부위를 안 주는 경우가 많아 축종이라도 화면에서 바로 보여야
  // 드롭다운에서 엉뚱한 걸 고르지 않는다). 이력조회로만 채워진다 — 스캔이나
  // 명세서엔 축종 필드 자체가 없다.
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
    conflict: null,
  });

  // 명세서 품목명 — 이력조회가 부위를 못 줘도 공급처가 자기 명세서엔 부위를
  // 적어 보낸다(사장님 지적: "돈 삼겹 냉장"처럼). 등급·원산지처럼 구조화된 값이
  // 아니라 원문 그대로라 정답 판정에는 못 쓰지만, 사람이 상품을 고를 때 보는
  // 참고 정보로는 이력조회보다 오히려 낫다.
  add({
    key: "documentItemName",
    label: "명세서 품목명",
    level: "RECOMMENDED",
    value: facts.documentItemName ?? null,
    source: facts.documentItemName ? "DOCUMENT" : null,
    hint: facts.documentItemName
      ? null
      : facts.documentMatched
        ? "연결된 명세서 줄에 품목명이 비어 있습니다."
        : "연결된 명세서가 없습니다.",
    conflict: null,
  });

  add({
    key: "product",
    label: "상품",
    level: "REQUIRED",
    value: facts.productName ?? (facts.productId ? "연결됨" : null),
    source: facts.productId ? "SCAN" : null,
    hint: facts.productId ? null : "이 박스가 어느 상품인지 골라주세요.",
    conflict: null,
  });

  add({
    key: "weight",
    label: "실중량",
    level: "REQUIRED",
    value: formatWeight(facts.weight),
    source: facts.weight === null ? null : "SCAN",
    hint: facts.weight === null ? "저울에 찍힌 무게를 입력해주세요." : null,
    conflict: null,
  });

  // 표기중량 — 바코드에 실려 오면 스캔이, 아니면 명세서가 채운다.
  // 실중량과 대조해 모자라게 온 걸 잡는 값이라 필수로 본다.
  const labeled = pick([
    { value: formatWeight(facts.labeledWeight), source: "SCAN" },
    { value: formatWeight(facts.documentLabeledWeight), source: "DOCUMENT" },
  ]);

  add({
    key: "labeledWeight",
    label: "표기중량",
    level: "REQUIRED",
    value: labeled.value,
    source: labeled.source,
    hint: labeled.value
      ? null
      : facts.documentMatched
        ? "명세서에도 중량이 없습니다. 공급처에 요청하세요."
        : "바코드에 중량이 없습니다. 명세서를 올리면 채워집니다.",
    conflict: null,
  });

  const supplier = pick([
    { value: facts.purchaseSupplier, source: "SCAN" },
    { value: facts.documentSupplier, source: "DOCUMENT" },
  ]);

  add({
    key: "supplier",
    label: "공급처",
    level: "REQUIRED",
    value: supplier.value,
    source: supplier.source,
    hint: supplier.value ? null : "명세서를 올리면 채워집니다.",
    conflict: null,
  });

  const unitPrice = pick([
    { value: formatMoney(facts.purchaseUnitPrice), source: "SCAN" },
    { value: formatMoney(facts.documentUnitPrice), source: "DOCUMENT" },
  ]);

  add({
    key: "unitPrice",
    label: "매입단가",
    level: "REQUIRED",
    value: unitPrice.value,
    source: unitPrice.source,
    hint: unitPrice.value
      ? null
      : facts.documentMatched
        ? "명세서에도 단가가 없습니다. 공급처에 요청하세요."
        : "명세서를 올리면 채워집니다.",
    conflict: null,
  });

  // 등급 — 공공조회가 1순위. 이력조회가 못 찾았으면 명세서가 받친다.
  const grade = pick([
    { value: facts.apiGrade, source: "TRACE_API" },
    { value: facts.documentGrade, source: "DOCUMENT" },
  ]);

  add({
    key: "grade",
    label: "등급",
    level: "RECOMMENDED",
    value: grade.value,
    source: grade.source,
    hint: grade.value
      ? null
      : facts.traceFound
        ? "이력조회에 등급이 없습니다. 명세서에 적혀 있으면 채워집니다."
        : "이력조회가 이 번호를 찾지 못했습니다.",
    conflict: conflictOf(facts.apiGrade, facts.documentGrade, "등급"),
  });

  // 원산지 — 필수. 공공조회 > 명세서 > 연결된 상품 순으로 본다.
  const origin = pick([
    { value: facts.apiOrigin, source: "TRACE_API" },
    { value: facts.documentOrigin, source: "DOCUMENT" },
    { value: facts.productOrigin, source: "PRODUCT" },
  ]);

  add({
    key: "origin",
    label: "원산지",
    level: "REQUIRED",
    value: origin.value,
    source: origin.source,
    hint: origin.value ? null : "이력조회·명세서·상품 어디에도 원산지가 없습니다.",
    conflict: conflictOf(facts.apiOrigin, facts.documentOrigin, "원산지"),
  });

  return {
    fields,
    missingRequired: fields.filter((field) => field.level === "REQUIRED" && !field.value).length,
    conflictCount: fields.filter((field) => field.conflict).length,
    documentMatched: facts.documentMatched,
  };
}
