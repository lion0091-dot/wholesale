/**
 * 축종별 상품 "정체성 키" — 같은 키면 같은 상품이라 중복 등록을 막고, 등록 후 그 항목들을 잠근다(사장님 결정, 2026-09-27):
 *   소   = 축종 + 품종(한우·육우·젖소) + 부위 + 등급 + 원산지   (등급까지 공공기관에 등록됨, 품종은 이력조회가 준다 — 사장님 2026-09-28)
 *   돼지 = 축종 + 부위 + 원산지
 *   닭·오리·계란 = 축종 + 원산지 (축종은 카테고리 자체 — 닭과 오리는 이력번호 첫 자리로 갈려 카테고리를 처음부터 나눴다)
 * 표에 없는 축종(양·가공육)은 예전 동작 그대로(폼 중복 검사·잠금·자동 이름 없음).
 * DB(마이그레이션 137·140: idx_products_cattle/pork/poultry_egg_identity, autocreate_product_for_scan)와 같은 규칙이다 — 바꾸면 그쪽도 같이 고칠 것.
 *
 * 상품명은 키가 아니라 표시 이름이다. 축종은 화면에서 `[소]` 태그로 자동으로 앞에 붙으므로(display-name.ts)
 * 소는 "품종 부위 등급", 돼지는 "부위"로, 닭·오리·계란은 축종 이름 그대로 저장한다.
 * DB 자동 생성(autocreate_product_for_scan)도 같은 이름 규칙을 쓴다.
 */

export type IdentityField = "breed" | "subcategory" | "grade" | "origin";

/** 소의 품종 — 이력조회의 축종 원문(한우/육우/젖소)과 같은 값. DB의 products.breed CHECK와 같은 목록이다. */
export const CATTLE_BREEDS: readonly string[] = ["한우", "육우", "젖소"];

const IDENTITY_FIELDS_BY_CATEGORY: Record<string, IdentityField[]> = {
  소: ["breed", "subcategory", "grade", "origin"],
  돼지: ["subcategory", "origin"],
  닭: ["origin"],
  오리: ["origin"],
  계란: ["origin"],
};

export const PART_UNSPECIFIED_LABEL = "(부위 미지정)";

export const IDENTITY_FIELD_LABELS: Record<IdentityField, string> = {
  breed: "품종",
  subcategory: "부위",
  grade: "등급",
  origin: "원산지",
};

/** 안내 문구용 — "축종·부위·원산지". 키 규칙이 없으면 빈 문자열. */
export function identityDescription(category: string | null | undefined): string {
  const fields = identityFieldsFor(category);

  return fields ? ["축종", ...fields.map((field) => IDENTITY_FIELD_LABELS[field])].join("·") : "";
}

/** 이 축종에 키 규칙이 있으면 키를 이루는 항목 목록(축종 자체는 항상 키), 없으면 null. */
export function identityFieldsFor(category: string | null | undefined): IdentityField[] | null {
  return (category && IDENTITY_FIELDS_BY_CATEGORY[category]) || null;
}

/**
 * 키 축종의 자동 상품명. 소는 "품종 부위 등급", 돼지는 "부위", 닭·오리·계란은 축종 이름.
 * 부위가 키인데 비어 있으면(이력으로 자동 생성된 상품 등) 끝에 "(부위 미지정)"을 붙인다.
 * 키 규칙이 없는 축종은 null(호출부가 사용자가 적은 이름을 그대로 쓴다).
 */
export function composeIdentityName(
  category: string | null | undefined,
  subcategory: string | null | undefined,
  grade: string | null | undefined,
  breed?: string | null | undefined
): string | null {
  const fields = identityFieldsFor(category);

  if (!fields || !category) {
    return null;
  }

  if (!fields.includes("subcategory")) {
    return category;
  }

  const part = subcategory?.trim() ?? "";
  const gradeText = fields.includes("grade") ? (grade?.trim() ?? "") : "";
  const breedText = fields.includes("breed") ? (breed?.trim() ?? "") : "";
  const name = [breedText, part, gradeText].filter(Boolean).join(" ");

  return part ? name : [name, PART_UNSPECIFIED_LABEL].filter(Boolean).join(" ");
}
