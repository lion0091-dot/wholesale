/**
 * 이력 관리 대상 축종 — 공공 이력제에 번호가 있어 상품이 입고 스캔으로만 만들어지는 카테고리(사장님 결정, 2026-09-26).
 *
 * 이 카테고리는 상품 관리 화면에서 손으로 등록하지 못한다. 손 등록을 허용하면 이력번호가 없는(키가 비는)
 * 같은 상품이 스캔 자동 생성 상품과 따로 생겨 중복이 된다. 양·가공육처럼 이력번호가 없는 품목만 손으로 등록한다.
 * 카테고리 이름은 product_categories와 master_livestock.species_group이 쓰는 값이다.
 */
export const TRACEABLE_CATEGORIES: readonly string[] = ["소", "돼지", "닭/오리"];

export function isTraceableCategory(category: string | null | undefined): boolean {
  return Boolean(category) && TRACEABLE_CATEGORIES.includes(category as string);
}

export const TRACEABLE_MANUAL_BLOCK_MESSAGE =
  "소·돼지·닭/오리 상품은 입고 스캔으로 자동 등록됩니다. 여기서는 이력번호가 없는 품목(양·가공육 등)만 직접 등록할 수 있습니다.";
