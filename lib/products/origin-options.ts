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
