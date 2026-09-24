/**
 * 축종별 상품 "정체성 키" — 같은 키면 같은 상품이라 중복 등록을 막고, 등록 후 그 항목들을 잠근다.
 *
 * 공공 이력 체계가 축종마다 다르다(사장님 결정, 2026-09-24):
 *   소   = 축종 + 부위 + 등급 + 원산지   (등급까지 공공기관에 등록됨)
 *   돼지·닭·오리·계란 = 이력번호에서 파싱한 출처(농장·도축장 …) + 명세서의 부위 — 이력번호가 있는 자동 생성 경로에서만 적용되며
 *     DB(products.trace_key, 마이그레이션 114)와 lib/livestock/trace-number.ts의 traceIdentityKey()에 있다. 이 표는 "사용자가 폼에 입력하는
 *     항목"이 키인 축종만 다루므로 여기엔 없다(수동 등록은 이력번호가 없어 그쪽 규칙의 검사 대상이 아님).
 * 규칙이 정해진 축종만 아래 표에 넣는다. 표에 없는 축종은 예전 동작 그대로(폼 중복 검사·잠금·자동 이름 없음).
 *
 * 상품명은 키가 아니라 표시 이름이다. 축종은 화면에서 `[소]` 태그로 자동으로 앞에 붙으므로(display-name.ts)
 * 키 축종의 상품명은 "부위 + 등급"으로만 저장한다 — 화면에는 "[소] 등심 1++"로 보인다.
 * DB 자동 생성(autocreate_product_for_scan)도 같은 이름 규칙을 쓴다(마이그레이션 113) — 여기를 고치면 그 함수도 같이 고칠 것.
 */

export type IdentityField = "subcategory" | "grade" | "origin";

const IDENTITY_FIELDS_BY_CATEGORY: Record<string, IdentityField[]> = {
  소: ["subcategory", "grade", "origin"],
};

export const PART_UNSPECIFIED_LABEL = "(부위 미지정)";

export const IDENTITY_FIELD_LABELS: Record<IdentityField, string> = {
  subcategory: "부위",
  grade: "등급",
  origin: "원산지",
};

/** 이 축종에 키 규칙이 있으면 키를 이루는 항목 목록(축종 자체는 항상 키), 없으면 null. */
export function identityFieldsFor(category: string | null | undefined): IdentityField[] | null {
  return (category && IDENTITY_FIELDS_BY_CATEGORY[category]) || null;
}

/**
 * 키 축종의 자동 상품명 — "부위 + 등급". 부위가 비어 있으면(이력으로 자동 생성된 상품 등) 끝에 "(부위 미지정)"을 붙인다.
 * 키 규칙이 없는 축종은 null(호출부가 사용자가 적은 이름을 그대로 쓴다).
 */
export function composeIdentityName(
  category: string | null | undefined,
  subcategory: string | null | undefined,
  grade: string | null | undefined
): string | null {
  if (!identityFieldsFor(category)) {
    return null;
  }

  const part = subcategory?.trim() ?? "";
  const gradeText = grade?.trim() ?? "";
  const name = [part, gradeText].filter(Boolean).join(" ");

  return part ? name : [name, PART_UNSPECIFIED_LABEL].filter(Boolean).join(" ");
}
