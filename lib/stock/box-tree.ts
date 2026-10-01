/**
 * 재고 보기 트리 — 박스 꼬리표를 축 순서로 접는다(docs/stock-redesign-boxes-and-conditions.md §3-4).
 * 순서는 고정(축종→부위→원산지→등급→성별→BMS→냉장/냉동). 모르는 값은 "모름" 가지로 센다.
 */

export interface TreeBox {
  tagSpecies: string | null;
  tagPart: string | null;
  tagOrigin: string | null;
  tagGrade: string | null;
  tagSex: string | null;
  tagBms: string | null;
  tagStorageState: string | null;
  remainingWeight: number;
}

export const TREE_AXES = ["축종", "부위", "원산지", "등급", "성별", "BMS", "냉장/냉동"] as const;

export const UNKNOWN_LABEL = "모름";

export interface TreeNode {
  /** 이 마디의 축 이름(루트는 null) */
  axis: (typeof TREE_AXES)[number] | null;
  label: string;
  boxes: number;
  weight: number;
  children: TreeNode[];
}

function axisValues(box: TreeBox): Array<string | null> {
  return [box.tagSpecies, box.tagPart, box.tagOrigin, box.tagGrade, box.tagSex, box.tagBms, box.tagStorageState];
}

function clean(value: string | null): string {
  const trimmed = (value ?? "").trim();

  return trimmed === "" ? UNKNOWN_LABEL : trimmed;
}

/** 모름은 항상 맨 뒤, 나머지는 가나다순(등급 같은 숫자 섞인 값도 문자열 비교로 충분 — 1++ < 1+ < 1 은 아래서 따로 처리). */
function compareLabels(a: string, b: string): number {
  if (a === UNKNOWN_LABEL) return 1;
  if (b === UNKNOWN_LABEL) return -1;

  return a.localeCompare(b, "ko");
}

/** 한우 등급은 사람이 읽는 순서(1++ → 1+ → 1 → 2 → 3, 혼합은 그 다음)로 둔다. */
const GRADE_ORDER = ["1++", "1+", "1", "2", "3", "혼합"];

function compareGrade(a: string, b: string): number {
  const ia = GRADE_ORDER.indexOf(a);
  const ib = GRADE_ORDER.indexOf(b);

  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;

  return compareLabels(a, b);
}

export function buildBoxTree(boxes: TreeBox[]): TreeNode {
  const root: TreeNode = { axis: null, label: "전체", boxes: 0, weight: 0, children: [] };

  for (const box of boxes) {
    root.boxes += 1;
    root.weight += box.remainingWeight;

    let node = root;

    axisValues(box).forEach((raw, depth) => {
      const label = clean(raw);
      let child = node.children.find((c) => c.label === label);

      if (!child) {
        child = { axis: TREE_AXES[depth], label, boxes: 0, weight: 0, children: [] };
        node.children.push(child);
      }

      child.boxes += 1;
      child.weight += box.remainingWeight;
      node = child;
    });
  }

  sortTree(root);

  return root;
}

function sortTree(node: TreeNode): void {
  const compare = node.children[0]?.axis === "등급" ? compareGrade : compareLabels;

  node.children.sort((a, b) => compare(a.label, b.label));
  node.children.forEach(sortTree);
}

/** 검색어가 라벨 어디에든(조상 포함) 걸리는 가지만 남긴다. 걸린 마디는 아래를 통째로 둔다. */
export function filterTree(node: TreeNode, query: string): TreeNode | null {
  const q = query.trim();

  if (q === "") return node;

  const keep = (n: TreeNode, ancestorHit: boolean): TreeNode | null => {
    const hit = ancestorHit || n.label.includes(q);

    if (hit) return n;

    const children = n.children.map((c) => keep(c, false)).filter((c): c is TreeNode => c !== null);

    if (children.length === 0) return null;

    return {
      ...n,
      children,
      boxes: children.reduce((sum, c) => sum + c.boxes, 0),
      weight: children.reduce((sum, c) => sum + c.weight, 0),
    };
  };

  return keep({ ...node, label: "" }, false);
}
