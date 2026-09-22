/**
 * 엑셀 대량 입고 파서 확인 (의존성 설치 없이 실행).
 *   node scripts/test-import-parser.mjs
 */
import { evaluateModules } from "./lib-strip-types.mjs";

// barcode-parser를 먼저 이어붙여 parseBarcode를 노출시킨다.
const parseImportTable = evaluateModules(
  ["lib/livestock/barcode-parser.ts", "lib/livestock/import-parser.ts"],
  "parseImportTable"
);

const cases = [
  {
    label: "CSV + 헤더",
    input: "이력번호,중량\n002123456789,8.2\n002999888777,7.5",
    valid: 2,
    errors: 0,
    first: { traceNo: "002123456789", weight: 8.2 },
  },
  {
    label: "엑셀 붙여넣기(탭)",
    input: "002123456789\t8.2\n002999888777\t7.5",
    valid: 2,
    errors: 0,
    first: { traceNo: "002123456789", weight: 8.2 },
  },
  {
    label: "중량 단위 표기",
    input: "002123456789,8.2kg\n002999888777,\"7,5\"",
    valid: 2,
    errors: 0,
  },
  {
    label: "GS1 바코드가 들어간 셀",
    input: "(01)08801234567890(3103)008200(251)002123456789",
    valid: 1,
    errors: 0,
    first: { traceNo: "002123456789", weight: 8.2 },
  },
  {
    label: "오류 줄 섞임",
    input: "002123456789,8.2\n이상한값,3\n002999888777,",
    valid: 1,
    errors: 2,
  },
  { label: "빈 입력", input: "", valid: 0, errors: 0 },
];

let failed = 0;

for (const testCase of cases) {
  const result = parseImportTable(testCase.input);
  const problems = [];

  if (result.validCount !== testCase.valid) {
    problems.push(`valid 기대 ${testCase.valid} / 실제 ${result.validCount}`);
  }
  if (result.errorCount !== testCase.errors) {
    problems.push(`error 기대 ${testCase.errors} / 실제 ${result.errorCount}`);
  }
  if (testCase.first) {
    const row = result.rows.find((item) => !item.error);
    if (!row || row.traceNo !== testCase.first.traceNo || row.weight !== testCase.first.weight) {
      problems.push(`첫 행 기대 ${JSON.stringify(testCase.first)} / 실제 ${JSON.stringify(row && { traceNo: row.traceNo, weight: row.weight })}`);
    }
  }

  if (problems.length > 0) {
    failed += 1;
    console.log(`❌ ${testCase.label}`);
    problems.forEach((problem) => console.log(`   ${problem}`));
  } else {
    console.log(`✅ ${testCase.label} → 정상 ${result.validCount} / 오류 ${result.errorCount}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log(`\n${cases.length}건 전부 통과`);
