/** 상품·발주서에서 원산지를 목록으로 고르는 축종(identity-key.ts의 키 축종)이 쓰는 값. 원산지는 표시 의무라 표기를 하나로 맞춘다. */
export const ORIGIN_OPTIONS: readonly string[] = [
  "국내산",
  "미국산",
  "호주산",
  "뉴질랜드산",
  "캐나다산",
  "브라질산",
  "스페인산",
  "기타 수입산",
];

export const OTHER_IMPORT_ORIGIN = "기타 수입산";

export const DOMESTIC_ORIGIN = "국내산";

/** 소의 품종·등급은 국내산에만 있는 개념(수입육 이력 API에 그 값 자체가 없음, 2026-09-28 확인)이라 이 판별로 폼 필수 여부를 가른다. */
export function isDomesticOrigin(origin: string | null | undefined): boolean {
  return (origin ?? "").trim() === DOMESTIC_ORIGIN;
}

const IMPORT_COUNTRIES = ORIGIN_OPTIONS.filter((name) => name !== "국내산" && name !== OTHER_IMPORT_ORIGIN).map((name) => name.replace(/산$/, ""));

/**
 * 수입 이력의 국가명(예: "미국")을 원산지 목록의 값("미국산")으로 옮긴다. 목록에 없는 나라·빈 값은 "기타 수입산".
 * DB의 trace_origin()(마이그레이션 137)과 같은 규칙이다 — 바꾸면 양쪽을 같이 고칠 것.
 */
export function normalizeImportedOrigin(country: string | null | undefined): string {
  const text = (country ?? "").trim();
  const hit = IMPORT_COUNTRIES.find((name) => text.includes(name));

  return hit ? `${hit}산` : OTHER_IMPORT_ORIGIN;
}

/**
 * 원산지 비교 — 한쪽이 다른 쪽을 포함하면 같은 원산지로 본다(사장님 결정 "원산지는 like로").
 * 둘 중 하나만 비어 있으면 다르다(빈 문자열은 모든 것에 포함되므로). DB의 origin_matches()(마이그레이션 137)와 같은 규칙이다.
 */
export function originMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? "").trim();
  const right = (b ?? "").trim();

  if (!left || !right) {
    return !left && !right;
  }

  return left.includes(right) || right.includes(left);
}
