import { describe, expect, it } from "vitest";
import { buildBoxTree, filterTree, UNKNOWN_LABEL, type TreeBox } from "./box-tree";

const box = (over: Partial<TreeBox>): TreeBox => ({
  tagSpecies: "소",
  tagPart: "등심",
  tagOrigin: "국내산",
  tagGrade: "1++",
  tagSex: "암",
  tagBms: "8",
  tagStorageState: "냉장",
  remainingWeight: 10,
  ...over,
});

describe("buildBoxTree", () => {
  it("합계는 루트와 모든 마디에서 박스 수·중량이 일치한다", () => {
    const tree = buildBoxTree([box({}), box({ tagGrade: "1+", remainingWeight: 5 }), box({ tagPart: "갈비", remainingWeight: 7 })]);

    expect(tree.boxes).toBe(3);
    expect(tree.weight).toBe(22);
    const somtree = tree.children[0];

    expect(somtree.label).toBe("소");
    expect(somtree.children.map((c) => [c.label, c.boxes, c.weight])).toEqual([
      ["갈비", 1, 7],
      ["등심", 2, 15],
    ]);
  });

  it("모르는 값은 '모름' 가지로 합계에 포함되고 맨 뒤에 온다", () => {
    const tree = buildBoxTree([box({ tagSex: null }), box({ tagSex: "  " }), box({ tagSex: "암" })]);
    const sexLevel = tree.children[0].children[0].children[0].children[0].children;

    expect(sexLevel.map((c) => c.label)).toEqual(["암", UNKNOWN_LABEL]);
    expect(sexLevel[1].boxes).toBe(2);
  });

  it("등급은 1++ → 1+ → 1 → 혼합 순, 혼합 박스도 한 가지로 센다", () => {
    const tree = buildBoxTree([
      box({ tagGrade: "혼합" }),
      box({ tagGrade: "1" }),
      box({ tagGrade: "1++" }),
      box({ tagGrade: "1+" }),
      box({ tagGrade: null }),
    ]);
    const gradeLevel = tree.children[0].children[0].children[0].children;

    expect(gradeLevel.map((c) => c.label)).toEqual(["1++", "1+", "1", "혼합", UNKNOWN_LABEL]);
  });

  it("빈 입력은 빈 루트", () => {
    const tree = buildBoxTree([]);

    expect(tree.boxes).toBe(0);
    expect(tree.children).toEqual([]);
  });
});

describe("filterTree", () => {
  const tree = buildBoxTree([box({}), box({ tagPart: "갈비", remainingWeight: 7 })]);

  it("빈 검색어는 그대로", () => {
    expect(filterTree(tree, "  ")).toBe(tree);
  });

  it("걸린 가지만 남기고 합계를 다시 센다", () => {
    const filtered = filterTree(tree, "갈비");

    expect(filtered?.boxes).toBe(1);
    expect(filtered?.weight).toBe(7);
  });

  it("아무것도 안 걸리면 null", () => {
    expect(filterTree(tree, "없는말")).toBeNull();
  });
});

describe("buildBoxTree — 묶음(boxCount)", () => {
  it("boxCount가 있으면 그 수만큼 박스로 센다(없으면 1개)", () => {
    const base = { tagSpecies: "소", tagPart: "등심", tagOrigin: "국내산", tagGrade: "1+", tagSex: null, tagBms: null, tagStorageState: "냉장" };
    const tree = buildBoxTree([
      { ...base, remainingWeight: 60, boxCount: 3 },
      { ...base, remainingWeight: 10 },
    ]);

    expect(tree.boxes).toBe(4);
    expect(tree.weight).toBe(70);
    expect(tree.children[0].boxes).toBe(4);
  });
});
