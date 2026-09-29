/**
 * 축종별 상품 "정체성 키" — 같은 키면 같은 상품이라 중복 등록을 막고, 등록 후 그 항목들을 잠근다(사장님 결정, 2026-09-27~09-30):
 *   소   = 축종 + 품종(한우·육우·젖소) + 부위 + 등급 + 성별(거세·암) + 원산지 + 냉장/냉동
 *   돼지 = 축종 + 부위 + 원산지 + 냉장/냉동
 *   닭·오리 = 축종 + 원산지 + 냉장/냉동 (축종은 카테고리 자체 — 닭과 오리는 이력번호 첫 자리로 갈려 카테고리를 처음부터 나눴다)
 *   계란 = 축종 + 원산지 (냉장/냉동 개념 없음)
 * 표에 없는 축종(양·가공육)은 예전 동작 그대로(폼 중복 검사·잠금·자동 이름 없음).
 * DB(마이그레이션 137·140·159: idx_products_cattle/pork/poultry_egg_identity, autocreate_product_for_scan)와
 * 같은 규칙이다 — 바꾸면 그쪽도 같이 고칠 것.
 *
 * BMS(마블링 지수, 근내지방도)는 소가 1++ 등급일 때만 추가로 정체성의 일부다(사장님 결정,
 * 2026-09-30) — 같은 1++라도 BMS(7/8/9)가 다르면 실제 매입원가가 다르기 때문. 1++가 아닌
 * 등급은 BMS 개념 자체가 없다(실제 이력조회 응답으로 확인). `identityFieldsFor`의 고정
 * 배열이 아니라 `bmsAppliesTo()`로 조건부 처리한다 — 다른 키 항목과 달리 등급 값에 따라
 * 켜지고 꺼지기 때문이다.
 *
 * 냉장/냉동은 공공 이력조회 API에 없는 값이다(공급처가 직접 표기하는 정보) — 그래서
 * 입고 스캔 자동 생성(autocreate_product_for_scan)은 이 값을 절대 채우지 못하고 항상
 * 비워 둔다(부위 미지정과 같은 패턴, 사람이 나중에 채운다). 계란은 냉장/냉동 구분이
 * 없는 품목이라 표에서 뺐다.
 *
 * 상품명은 키가 아니라 표시 이름이다. 축종은 화면에서 `[소]` 태그로 자동으로 앞에 붙으므로(display-name.ts)
 * 소는 "냉장/냉동 품종 부위 등급 성별 (BMS)", 돼지는 "냉장/냉동 부위", 닭·오리는 "냉장/냉동 축종",
 * 계란은 축종 이름 그대로 저장한다. DB 자동 생성(autocreate_product_for_scan)도 같은 이름 규칙을 쓴다.
 */

export type IdentityField = "breed" | "subcategory" | "grade" | "sex" | "origin" | "storageState";

/** 소의 품종 — 이력조회의 축종 원문(한우/육우/젖소)과 같은 값. DB의 products.breed CHECK와 같은 목록이다. */
export const CATTLE_BREEDS: readonly string[] = ["한우", "육우", "젖소"];

/** 소 등급 — 축산물품질평가원 표준 5단계. 수입육은 등급 개념이 없어 이 목록을 쓰지 않는다. */
export const CATTLE_GRADES: readonly string[] = ["1++", "1+", "1", "2", "3"];

/**
 * 소의 성별 — 이력조회 응답의 sexNm 원문 그대로("거세우"/"암소"가 아니라 "거세"/"암"
 * 두 값만 실제로 나온다, 2026-09-30 실조회로 확인).
 */
export const CATTLE_SEXES: readonly string[] = ["거세", "암"];

/**
 * 1++ 등급 소에서만 쓰는 BMS(마블링 지수) 선택지 — 이력조회 응답의 insfat 원문 그대로
 * 접두어 없는 숫자 문자열이다(2026-09-30 실조회로 확인, "No.7" 같은 표기는 API에 없음).
 */
export const BMS_VALUES: readonly string[] = ["9", "8", "7"];

/** 냉장/냉동 — 공공 API에 없는, 공급처가 직접 표기하는 정보다. 계란 제외 전 축종 공통. */
export const STORAGE_STATES: readonly string[] = ["냉장", "냉동"];

/** BMS가 이 상품의 정체성 일부인지 — 소이면서 등급이 1++일 때만(다른 등급·축종은 BMS 개념이 없다). */
export function bmsAppliesTo(category: string | null | undefined, grade: string | null | undefined): boolean {
  return category === "소" && grade === "1++";
}

/**
 * "등급(BMS)" 한 조각 — BMS는 등급 바로 뒤에 괄호로 붙여야 등급·BMS가 한 묶음으로
 * 읽힌다(예: "1++(9)", 사장님 지적 2026-09-30). 이 조립을 상품명(composeIdentityName)·
 * 발주서 목록 라벨(productSpecLabel)·카톡 문구(buildPurchaseOrderMessage)·발주서 화면
 * 미리보기(specText) 네 곳이 각자 따로 구현했다가 한 곳만 고쳐서 표기가 갈리는 버그가
 * 실제로 있었다(통단테 발견, 2026-09-30) — 그래서 이 한 조각만 공유 함수로 뺀다.
 * bmsAppliesTo가 이미 "소·1++"만 걸러주므로 호출부는 등급 필드 사용 여부(예: 돼지는
 * 애초에 grade 자체를 안 씀)만 자기 쪽에서 가리면 된다.
 */
export function formatGradeWithBms(
  category: string | null | undefined,
  grade: string | null | undefined,
  bms: string | null | undefined
): string {
  const gradeText = (grade ?? "").trim();
  const bmsText = bmsAppliesTo(category, grade) ? (bms ?? "").trim() : "";

  return bmsText ? `${gradeText}(${bmsText})` : gradeText;
}

const IDENTITY_FIELDS_BY_CATEGORY: Record<string, IdentityField[]> = {
  소: ["breed", "subcategory", "grade", "sex", "origin", "storageState"],
  돼지: ["subcategory", "origin", "storageState"],
  닭: ["origin", "storageState"],
  오리: ["origin", "storageState"],
  계란: ["origin"],
};

export const PART_UNSPECIFIED_LABEL = "(부위 미지정)";

export const IDENTITY_FIELD_LABELS: Record<IdentityField, string> = {
  breed: "품종",
  subcategory: "부위",
  grade: "등급",
  sex: "성별",
  origin: "원산지",
  storageState: "냉장/냉동",
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

export interface IdentityValues {
  subcategory?: string | null;
  grade?: string | null;
  breed?: string | null;
  sex?: string | null;
  /** 등급이 1++일 때만 반영된다(bmsAppliesTo) — 다른 등급에 값이 들어와도 무시한다. */
  bms?: string | null;
  storageState?: string | null;
}

/**
 * 키 축종의 자동 상품명. 소는 "냉장/냉동 품종 부위 등급(BMS) 성별", 돼지는 "냉장/냉동 부위",
 * 닭·오리는 "냉장/냉동 축종", 계란은 축종 이름. BMS는 등급 바로 뒤에 괄호로 붙인다(예: "1++(9)") —
 * 등급과 BMS가 한 묶음으로 읽혀야 어떤 상품인지 헷갈리지 않는다(사장님 지적, 2026-09-30).
 * 부위가 키인데 비어 있으면(이력으로 자동 생성된 상품 등) 끝에 "(부위 미지정)"을 붙인다.
 * 키 규칙이 없는 축종은 null(호출부가 사용자가 적은 이름을 그대로 쓴다).
 */
export function composeIdentityName(
  category: string | null | undefined,
  values: IdentityValues
): string | null {
  const fields = identityFieldsFor(category);

  if (!fields || !category) {
    return null;
  }

  const storageText = fields.includes("storageState") ? (values.storageState?.trim() ?? "") : "";

  if (!fields.includes("subcategory")) {
    return [storageText, category].filter(Boolean).join(" ");
  }

  const part = values.subcategory?.trim() ?? "";
  const breedText = fields.includes("breed") ? (values.breed?.trim() ?? "") : "";
  const sexText = fields.includes("sex") ? (values.sex?.trim() ?? "") : "";
  const gradeWithBms = fields.includes("grade") ? formatGradeWithBms(category, values.grade, values.bms) : "";
  const name = [storageText, breedText, part, gradeWithBms, sexText]
    .filter(Boolean)
    .join(" ");

  return part ? name : [name, PART_UNSPECIFIED_LABEL].filter(Boolean).join(" ");
}
