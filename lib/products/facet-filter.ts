/**
 * 상품 목록 체크박스 필터(축종·부위·원산지·등급) — 상품 관리와 미니샵이 같이 쓴다.
 * 같은 그룹 안에서는 "또는", 그룹끼리는 "그리고". 아무것도 안 고르면 전부 통과한다.
 * 부위 목록은 고른 축종에 있는 부위만 보여준다(부위가 너무 많아지는 것 방지).
 */

export interface FacetProduct {
  category: string;
  subcategory: string | null;
  origin: string | null;
  grade: string | null;
}

export type FacetKey = "species" | "part" | "origin" | "grade";

export type FacetSelection = Record<FacetKey, string[]>;

export const EMPTY_FACETS: FacetSelection = { species: [], part: [], origin: [], grade: [] };

export const FACET_LABELS: Record<FacetKey, string> = { species: "축종", part: "부위", origin: "원산지", grade: "등급" };

export const FACET_ORDER: FacetKey[] = ["species", "part", "origin", "grade"];

/** 값이 비어 있는 상품은 이 이름으로 모은다. */
export const FACET_NONE_LABEL = "미지정";

const GRADE_ORDER = ["1++", "1+", "1", "2", "3"];

function valueOf(product: FacetProduct, key: FacetKey): string {
  const raw = key === "species" ? product.category : key === "part" ? product.subcategory : key === "origin" ? product.origin : product.grade;
  const trimmed = (raw ?? "").trim();

  return trimmed === "" ? FACET_NONE_LABEL : trimmed;
}

export function facetCount(selection: FacetSelection): number {
  return FACET_ORDER.reduce((sum, key) => sum + selection[key].length, 0);
}

function passes(product: FacetProduct, selection: FacetSelection, skip?: FacetKey): boolean {
  return FACET_ORDER.every((key) => {
    if (key === skip) return true;

    const picked = selection[key];

    return picked.length === 0 || picked.includes(valueOf(product, key));
  });
}

export function matchesFacets(product: FacetProduct, selection: FacetSelection): boolean {
  return passes(product, selection);
}

export interface FacetOption {
  value: string;
  count: number;
}

function compareOptions(key: FacetKey, a: string, b: string): number {
  if (a === FACET_NONE_LABEL) return 1;
  if (b === FACET_NONE_LABEL) return -1;

  if (key === "grade") {
    const ia = GRADE_ORDER.indexOf(a);
    const ib = GRADE_ORDER.indexOf(b);

    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
  }

  return a.localeCompare(b, "ko");
}

/**
 * 그룹별 선택지와 개수. 개수는 "다른 그룹의 선택은 지키고 이 그룹의 선택은 무시한" 상품 수라서
 * 체크하기 전에 눌렀을 때 몇 개가 나올지 미리 알 수 있다.
 * 이미 체크한 값은 개수가 0이어도 남겨 둬서 풀 수 있게 한다.
 */
export function buildFacetOptions(products: FacetProduct[], selection: FacetSelection): Record<FacetKey, FacetOption[]> {
  const result = { species: [], part: [], origin: [], grade: [] } as Record<FacetKey, FacetOption[]>;

  for (const key of FACET_ORDER) {
    const counts = new Map<string, number>();

    for (const product of products) {
      // 부위는 고른 축종 안의 것만(축종을 안 골랐으면 전부).
      if (!passes(product, selection, key)) continue;

      const value = valueOf(product, key);

      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    for (const picked of selection[key]) {
      if (!counts.has(picked)) counts.set(picked, 0);
    }

    result[key] = Array.from(counts, ([value, count]) => ({ value, count })).sort((a, b) => compareOptions(key, a.value, b.value));
  }

  return result;
}

/** 축종을 바꿔 더는 선택지에 없는 부위 선택이 남지 않게 정리한다. */
export function pruneSelection(products: FacetProduct[], selection: FacetSelection): FacetSelection {
  const options = buildFacetOptions(products, selection);
  const pruned: FacetSelection = { ...selection };

  // 개수가 0인데 남아 있는 부위·원산지·등급은 현재 조건에서 의미가 없으니 푼다(축종은 그대로 둔다).
  for (const key of ["part", "origin", "grade"] as const) {
    pruned[key] = selection[key].filter((value) => (options[key].find((option) => option.value === value)?.count ?? 0) > 0);
  }

  return pruned;
}
