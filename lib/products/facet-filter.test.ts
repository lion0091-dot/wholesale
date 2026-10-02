import { describe, expect, it } from "vitest";
import { buildFacetOptions, EMPTY_FACETS, FACET_NONE_LABEL, matchesFacets, pruneSelection, type FacetProduct } from "./facet-filter";

const P = (category: string, subcategory: string | null, origin: string | null, grade: string | null): FacetProduct => ({ category, subcategory, origin, grade });

const products = [
  P("소", "등심", "국내산", "1++"),
  P("소", "등심", "호주산", null),
  P("소", "안심", "국내산", "1+"),
  P("돼지", "삼겹살", "국내산", null),
  P("돼지", "목살", null, null),
];

describe("matchesFacets", () => {
  it("아무것도 안 고르면 전부 통과한다", () => {
    expect(products.every((p) => matchesFacets(p, EMPTY_FACETS))).toBe(true);
  });

  it("같은 그룹은 또는, 그룹끼리는 그리고", () => {
    const sel = { ...EMPTY_FACETS, species: ["소", "돼지"], origin: ["국내산"] };

    expect(products.filter((p) => matchesFacets(p, sel)).length).toBe(3);
  });

  it("값이 비어 있는 상품은 '미지정'으로 걸러낼 수 있다", () => {
    const sel = { ...EMPTY_FACETS, origin: [FACET_NONE_LABEL] };

    expect(products.filter((p) => matchesFacets(p, sel)).map((p) => p.subcategory)).toEqual(["목살"]);
  });
});

describe("buildFacetOptions", () => {
  it("부위는 고른 축종에 있는 것만 보인다", () => {
    const options = buildFacetOptions(products, { ...EMPTY_FACETS, species: ["돼지"] });

    expect(options.part.map((o) => o.value)).toEqual(["목살", "삼겹살"]);
  });

  it("개수는 다른 그룹 선택을 지키고 자기 그룹 선택은 무시한다", () => {
    const options = buildFacetOptions(products, { ...EMPTY_FACETS, species: ["소"], origin: ["국내산"] });

    expect(options.species.find((o) => o.value === "돼지")?.count).toBe(1);
    expect(options.species.find((o) => o.value === "소")?.count).toBe(2);
    expect(options.origin.find((o) => o.value === "호주산")?.count).toBe(1);
  });

  it("등급은 사람이 읽는 순서, 미지정은 맨 뒤", () => {
    const options = buildFacetOptions(products, EMPTY_FACETS);

    expect(options.grade.map((o) => o.value)).toEqual(["1++", "1+", FACET_NONE_LABEL]);
  });

  it("이미 체크한 값은 개수 0이어도 남는다", () => {
    const options = buildFacetOptions(products, { ...EMPTY_FACETS, species: ["돼지"], grade: ["1++"] });

    expect(options.grade.find((o) => o.value === "1++")?.count).toBe(0);
  });
});

describe("pruneSelection", () => {
  it("축종을 바꾸면 그 축종에 없는 부위 선택은 풀린다", () => {
    const pruned = pruneSelection(products, { ...EMPTY_FACETS, species: ["돼지"], part: ["등심", "삼겹살"] });

    expect(pruned.part).toEqual(["삼겹살"]);
    expect(pruned.species).toEqual(["돼지"]);
  });
});
