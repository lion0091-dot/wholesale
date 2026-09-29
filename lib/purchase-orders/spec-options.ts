/**
 * 발주서 줄에서 목록으로만 고르게 하는 칸 — 상품을 가르는 기준(사장님 결정, 2026-09-27):
 *   소 = 축종+품종+부위+등급+원산지, 돼지 = 축종+부위+원산지, 닭·오리·계란 = 축종+원산지. 그 밖의 칸은 자유 기입.
 * 값이 비어 있는 것은 허용한다(느슨한 발주). 값이 있으면 목록 안의 것이어야 한다 — 오타로 같은 물건이 둘로 갈리는 걸 막기 위해서다.
 * 상품 정체성 키(lib/products/identity-key.ts)와 같은 기준이다 — 원산지 목록은 lib/products/origin-options.ts.
 */

export { ORIGIN_OPTIONS } from "@/lib/products/origin-options";
export { CATTLE_BREEDS, CATTLE_GRADES } from "@/lib/products/identity-key";

export interface SpecListRule {
  breedFromList: boolean;
  partFromList: boolean;
  gradeFromList: boolean;
  originFromList: boolean;
}

const NO_LIST_RULE: SpecListRule = { breedFromList: false, partFromList: false, gradeFromList: false, originFromList: false };

const SPEC_LIST_RULES: Record<string, SpecListRule> = {
  소: { breedFromList: true, partFromList: true, gradeFromList: true, originFromList: true },
  돼지: { breedFromList: false, partFromList: true, gradeFromList: false, originFromList: true },
  닭: { breedFromList: false, partFromList: false, gradeFromList: false, originFromList: true },
  오리: { breedFromList: false, partFromList: false, gradeFromList: false, originFromList: true },
  계란: { breedFromList: false, partFromList: false, gradeFromList: false, originFromList: true },
};

export function specListRuleFor(category: string | null | undefined): SpecListRule {
  return (category && SPEC_LIST_RULES[category]) || NO_LIST_RULE;
}
