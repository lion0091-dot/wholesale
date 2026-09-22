/**
 * 바코드 파서 동작 확인 (의존성 설치 없이 실행).
 *   node scripts/test-barcode-parser.mjs
 */
import { evaluateModules } from "./lib-strip-types.mjs";

const parseBarcode = evaluateModules(["lib/livestock/barcode-parser.ts"], "parseBarcode");

const cases = [
  { label: "순수 이력번호", input: "002123456789", traceNo: "002123456789", weightKg: null },
  { label: "묶음번호(L)", input: "L01234567890123", traceNo: "L01234567890123", weightKg: null },
  { label: "묶음번호(15자리)", input: "012345678901234", traceNo: "012345678901234", weightKg: null },
  {
    label: "GS1 괄호표기",
    input: "(01)08801234567890(3103)008200(11)260813(10)LOT123(251)002123456789",
    traceNo: "002123456789",
    weightKg: 8.2,
    packingDate: "2026-08-13",
  },
  {
    label: "GS1 구분자 없음",
    input: "01088012345678903103008200" + "11260813" + "251002123456789",
    traceNo: "002123456789",
    weightKg: 8.2,
    packingDate: "2026-08-13",
  },
  {
    label: "QR(URL)",
    input: "https://mtrace.go.kr/mtrace/search?traceNo=002123456789",
    traceNo: "002123456789",
    weightKg: null,
  },
  {
    label: "자체 세트번호",
    input: "SET-260922-001",
    traceNo: "SET-260922-001",
    weightKg: null,
    format: "bundle",
  },
  {
    label: "자체 세트번호(소문자 입력)",
    input: "set-260922-012",
    traceNo: "SET-260922-012",
    weightKg: null,
    format: "bundle",
  },
  { label: "잡음 섞인 값", input: "TRACE:002123456789 END", traceNo: "002123456789", weightKg: null },
  { label: "빈 값", input: "", traceNo: null, weightKg: null },
];

let failed = 0;

for (const testCase of cases) {
  const result = parseBarcode(testCase.input);
  const checks = ["traceNo", "weightKg", "packingDate", "format"].filter((key) => key in testCase);
  const bad = checks.filter((key) => result[key] !== testCase[key]);

  if (bad.length > 0) {
    failed += 1;
    console.log(`❌ ${testCase.label}`);
    for (const key of bad) {
      console.log(`   ${key}: 기대 ${JSON.stringify(testCase[key])} / 실제 ${JSON.stringify(result[key])}`);
    }
  } else {
    console.log(`✅ ${testCase.label} → ${result.traceNo ?? "(없음)"}${result.weightKg ? ` / ${result.weightKg}kg` : ""}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log(`\n${cases.length}건 전부 통과`);
