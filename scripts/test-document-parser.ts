/**
 * 공급처 명세서 파서 확인.
 *
 *   npx tsc --outDir .tsbuild --module es2022 --target es2022 --moduleResolution bundler \
 *     lib/livestock/document-parser.ts scripts/test-document-parser.ts
 *   node .tsbuild/scripts/test-document-parser.js
 *
 * 기존 test-*.mjs 들은 lib-strip-types.mjs(정규식으로 타입 표기 제거)를 쓰지만,
 * 이 파서는 타입 술어(`n is number`)·제네릭 등 그 스크립트가 감당 못 하는 문법을
 * 쓴다. npm 레지스트리가 복구돼 이미 설치돼 있는 typescript로 그냥 컴파일하면
 * 되므로 취약한 정규식을 늘리지 않는다.
 */

import { applyColumnMap, parseDocumentText } from "../lib/livestock/document-parser";
import type { ApplyOptions, ColumnMap, DocumentField } from "../lib/livestock/document-parser";

interface TestCase {
  label: string;
  input: string;
  expectColumns?: Partial<Record<DocumentField, number>>;
  expectLineCount?: number;
  expectFirst?: Partial<Record<DocumentField, string | number | null>>;
  overrideMap?: ColumnMap;
  overrideOptions?: ApplyOptions;
}

const cases: TestCase[] = [
  {
    label: "헤더 있는 CSV (품목/중량/단가/금액)",
    input: [
      "품목명,중량(kg),단가,금액",
      "한우 등심 1++,8.20,52000,426400",
      "한우 채끝 1+,7.50,41000,307500",
    ].join("\n"),
    expectColumns: { itemName: 0, labeledWeight: 1, unitPrice: 2, amount: 3 },
    expectLineCount: 2,
    expectFirst: { itemName: "한우 등심 1++", labeledWeight: 8.2, unitPrice: 52000, amount: 426400 },
  },
  {
    label: "이력번호가 적혀 오는 공급처",
    input: [
      "이력번호\t품명\t중량\t단가\t공급가액",
      "002191840078\t삼겹살\t12.400\t18000\t223200",
      "002141592286\t목살\t9.800\t16000\t156800",
    ].join("\n"),
    expectColumns: { traceNo: 0, itemName: 1, labeledWeight: 2, unitPrice: 3, amount: 4 },
    expectLineCount: 2,
    expectFirst: { traceNo: "002191840078", itemName: "삼겹살", labeledWeight: 12.4 },
  },
  {
    label: "합계 줄은 품목에서 제외",
    input: [
      "품목,중량,금액",
      "삼겹살,10.0,180000",
      "목살,8.0,128000",
      "합계,18.0,308000",
    ].join("\n"),
    expectLineCount: 2,
  },
  {
    label: "헤더 없는 붙여넣기 — 내용으로 추측",
    input: ["삼겹살\t10.5\t18000\t189000", "목살\t8.2\t16000\t131200"].join("\n"),
    expectLineCount: 2,
    expectFirst: { itemName: "삼겹살" },
  },
  {
    label: "천단위 쉼표와 단위 표기",
    input: ['품목,중량,금액\n한우 등심,"8.2kg","426,400"'].join("\n"),
    expectLineCount: 1,
    expectFirst: { labeledWeight: 8.2, amount: 426400 },
  },
  {
    // 알아볼 수 없는 헤더("A,B,C")는 자동으로는 헤더로 안 잡힌다 — 그게 맞다.
    // 사람이 화면에서 칸과 헤더 줄을 함께 짚어주면 그대로 따라야 한다.
    label: "사람이 칸과 헤더 줄을 직접 고친 경우",
    input: ["A,B,C", "삼겹살,10.5,18000"].join("\n"),
    overrideMap: { itemName: 0, labeledWeight: 1, unitPrice: 2 },
    overrideOptions: { headerRowIndex: 0 },
    expectLineCount: 1,
    expectFirst: { itemName: "삼겹살", labeledWeight: 10.5, unitPrice: 18000 },
  },
  {
    label: "사람이 특정 줄을 빼달라고 한 경우",
    input: ["품목,중량,금액", "삼겹살,10.0,180000", "반품분,2.0,-36000"].join("\n"),
    overrideOptions: { excludeRowIndexes: [2] },
    expectLineCount: 1,
    expectFirst: { itemName: "삼겹살" },
  },
  {
    label: "등급 칸이 있는 서류",
    input: [
      "품목,등급,중량,단가,금액",
      "한우 등심,1++,8.20,52000,426400",
      "한우 채끝,1+,7.50,41000,307500",
    ].join("\n"),
    expectColumns: { itemName: 0, grade: 1, labeledWeight: 2, unitPrice: 3, amount: 4 },
    expectLineCount: 2,
    expectFirst: { itemName: "한우 등심", grade: "1++", labeledWeight: 8.2 },
  },
  {
    // "1+등급"처럼 등급 뒤에 글자가 붙어 와도 등급만 남겨야 한다.
    label: "헤더 없이 등급만 내용으로 판별 (1+등급 표기)",
    input: ["삼겹살\t1+등급\t10.5\t18000\t189000", "목살\t1등급\t8.2\t16000\t131200"].join("\n"),
    expectLineCount: 2,
    expectFirst: { itemName: "삼겹살", grade: "1+" },
  },
  { label: "빈 입력", input: "", expectLineCount: 0 },
];

let failed = 0;

for (const testCase of cases) {
  const grid = parseDocumentText(testCase.input);
  const map = testCase.overrideMap ?? grid.columnMap;
  const lines = applyColumnMap(grid, map, testCase.overrideOptions);
  const problems: string[] = [];

  if (testCase.expectColumns) {
    for (const [field, column] of Object.entries(testCase.expectColumns)) {
      const actual = map[field as DocumentField];

      if (actual !== column) {
        problems.push(`칸 ${field} 기대 ${column} / 실제 ${actual}`);
      }
    }
  }

  if (testCase.expectLineCount !== undefined && lines.length !== testCase.expectLineCount) {
    problems.push(`줄 수 기대 ${testCase.expectLineCount} / 실제 ${lines.length}`);
  }

  if (testCase.expectFirst) {
    const first = lines[0];

    for (const [field, value] of Object.entries(testCase.expectFirst)) {
      const actual = first?.[field as keyof typeof first];

      if (actual !== value) {
        problems.push(`첫 줄 ${field} 기대 ${String(value)} / 실제 ${String(actual)}`);
      }
    }
  }

  if (problems.length > 0) {
    failed += 1;
    console.log(`FAIL  ${testCase.label}`);
    problems.forEach((problem) => console.log(`      ${problem}`));
    console.log(`      추측: ${JSON.stringify(grid.columnMap)}`);
  } else {
    console.log(`ok    ${testCase.label} (${lines.length}줄)`);
  }
}

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log(`\n${cases.length}건 전부 통과`);
