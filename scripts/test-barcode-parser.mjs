/**
 * 바코드 파서 동작 확인 (의존성 설치 없이 실행).
 *   node scripts/test-barcode-parser.mjs
 */
import { evaluateModules } from "./lib-strip-types.mjs";

const parseBarcode = evaluateModules(["lib/livestock/barcode-parser.ts"], "parseBarcode");

// GS1-128 요소 구분자(FNC1 이후 실제 전송되는 그룹 분리자). 파서 내부 상수와 값이 같아야 한다.
const GS = "\u001d";

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
  { label: "잡음 섞인 값", input: "TRACE:002123456789 END", traceNo: "002123456789", weightKg: null },
  { label: "빈 값", input: "", traceNo: null, weightKg: null },
  // 아래부터는 실제 스캔 원문을 구할 수 없어(물리 라벨이라 텍스트로 공개된 예시가 없음)
  // GS1 공식 일반사양(General Specifications)의 AI 인코딩 규칙대로 직접 구성한
  // 경계 케이스다. 국내 도매 유통에서 실제로 나올 수 있는 조합 위주.
  {
    label: "GS1 다른 소수점자리(3102=2자리) + 실제 GS 구분자",
    input: "01" + "08801234567890" + "3102" + "000820" + "10" + "LOT999" + GS + "17" + "270101" + "251" + "002123456789",
    traceNo: "002123456789",
    weightKg: 8.2,
    bestBefore: "2027-01-01",
    lotNo: "LOT999",
    gtin: "08801234567890",
  },
  {
    label: "AI 순서가 뒤바뀐 경우(중량이 GTIN보다 먼저)",
    input: "3102" + "000820" + "01" + "08801234567890" + "10" + "LOTXYZ" + GS + "17" + "270101" + "251" + "002123456789",
    traceNo: "002123456789",
    weightKg: 8.2,
    gtin: "08801234567890",
  },
  {
    label: "이력번호가 251이 아니라 뒤섞인 241(고객부품번호)과 함께 오는 경우",
    input: "241" + "SUPP123" + GS + "251" + "002123456789",
    traceNo: "002123456789",
    weightKg: null,
  },
  {
    label: "박스 여러 개가 든 상자(SSCC, AI 00)로 시작 — 구분자 없이 이어붙음",
    input: "00" + "123456789012345675" + "01" + "08801234567890" + "3103" + "008200" + "251" + "002123456789",
    traceNo: "002123456789",
    weightKg: 8.2,
    gtin: "08801234567890",
  },
  {
    label: "우리가 안 쓰는 계량단위(320n=lb)는 무시하고 다음 AI를 계속 읽는다",
    input: "01" + "08801234567890" + "3201" + "000180" + "251" + "002123456789",
    traceNo: "002123456789",
    weightKg: null,
    gtin: "08801234567890",
  },
];

let failed = 0;

for (const testCase of cases) {
  const result = parseBarcode(testCase.input);
  // 케이스에 적어둔 필드는 전부 검증한다 — 예전엔 4개만 고정으로 체크해서
  // lotNo/bestBefore/gtin을 적어놔도 실제로는 검증되지 않고 통과 표시가 났었다.
  const checks = Object.keys(testCase).filter((key) => key !== "label" && key !== "input");
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
