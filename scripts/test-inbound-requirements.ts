/**
 * 입고 건 필수항목 체크리스트 확인.
 *
 *   npx tsc --outDir .tsbuild --module commonjs --target es2022 --moduleResolution node \
 *     --skipLibCheck scripts/test-inbound-requirements.ts
 *   node .tsbuild/scripts/test-inbound-requirements.js
 */

import {
  buildScanRequirementReport,
  resolveTraceOrigin,
  type ScanFacts,
} from "../lib/livestock/inbound-requirements";

/** 다 갖춰진 스캔 한 건. 각 테스트는 여기서 필요한 것만 비운다. */
function facts(overrides: Partial<ScanFacts> = {}): ScanFacts {
  return {
    traceNo: "002191840078",
    productId: "prod-1",
    productName: "한우 등심 1++",
    productOrigin: "국내산",
    weight: 8.15,
    labeledWeight: 8.2,
    purchaseUnitPrice: 52000,
    purchaseSupplier: "대성축산",
    traceFound: true,
    apiGrade: "1++",
    apiOrigin: "국내산",
    ...overrides,
  };
}

let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function field(report: ReturnType<typeof buildScanRequirementReport>, key: string) {
  return report.fields.find((item) => item.key === key);
}

// 1) 이력조회와 스캔 입력이 다 붙으면 필수 항목이 전부 찬다.
{
  const report = buildScanRequirementReport(facts());

  check(
    "이력조회 + 스캔 입력이 다 붙으면 빠진 필수 항목 없음",
    report.missingRequired === 0,
    JSON.stringify(report.fields.filter((f) => f.level === "REQUIRED" && !f.value)),
  );
}

// 2) 값의 출처가 항목마다 드러나야 한다 — 이게 이 화면의 목적이다.
{
  const report = buildScanRequirementReport(facts());

  check("실중량은 스캔에서 온다", field(report, "weight")?.source === "SCAN");
  check("등급은 이력조회에서 온다", field(report, "grade")?.source === "TRACE_API");
  check("공급처는 스캔(지금 온 거래처)에서 온다", field(report, "supplier")?.source === "SCAN");
  check("매입단가도 스캔에서", field(report, "unitPrice")?.source === "SCAN");
}

// 3) 매입단가·공급처가 비어 있으면 입력하라고 안내한다.
{
  const report = buildScanRequirementReport(facts({ purchaseUnitPrice: null, purchaseSupplier: null }));

  check(
    "공급처가 비면 골라달라고 안내",
    !field(report, "supplier")?.value && field(report, "supplier")?.hint?.includes("거래처") === true,
    JSON.stringify(field(report, "supplier")),
  );
  check(
    "단가가 비면 입력하라고 안내",
    field(report, "unitPrice")?.hint?.includes("매입단가") === true,
  );
  check("빠진 필수 2건으로 셈", report.missingRequired === 2);
}

// 4) 원산지 우선순위 — 이력조회 > 연결된 상품.
{
  const viaProduct = buildScanRequirementReport(facts({ apiOrigin: null, traceFound: false }));
  const nowhere = buildScanRequirementReport(
    facts({ apiOrigin: null, traceFound: false, productOrigin: null, productId: null, productName: null }),
  );

  check("이력조회가 없으면 연결된 상품이 받친다", viaProduct.fields.find((f) => f.key === "origin")?.source === "PRODUCT");
  check(
    "상품도 없으면 비고 필수 누락",
    !nowhere.fields.find((f) => f.key === "origin")?.value && nowhere.missingRequired >= 1,
  );
}

// 5) 이력조회가 번호를 못 찾은 경우의 안내가 달라야 한다.
{
  const report = buildScanRequirementReport(facts({ traceFound: false, apiGrade: null }));

  check(
    "이력조회 실패 시 등급 안내가 그 사실을 말함",
    field(report, "grade")?.hint?.includes("찾지 못했") === true,
    field(report, "grade")?.hint ?? "",
  );
  check("등급은 권장이라 필수 누락으로 안 셈", report.missingRequired === 0);
}

// 6) 상품 미연결은 사람이 골라야 하는 필수 항목이다.
{
  const report = buildScanRequirementReport(facts({ productId: null, productName: null }));

  check(
    "상품 미연결 → 값 없음 + 고르라고 안내",
    !field(report, "product")?.value &&
      field(report, "product")?.hint?.includes("골라주세요") === true,
  );
}

// 7) 국내 이력제에 번호가 있으면 원산지는 국내산이다.
//    실제 적재 레코드에서 origin_country가 비어 있는 것을 확인했고, 국내
//    이력제가 국내 사육·도축분만 다루기 때문에 성립하는 판정이다.
{
  check("국내 이력제 기록 + 빈 원산지 → 국내산", resolveTraceOrigin("mtrace_livestock", null) === "국내산");
  check(
    "API가 원산지를 명시했으면 그 값이 우선",
    resolveTraceOrigin("mtrace_imported", "미국") === "미국산" && resolveTraceOrigin("mtrace_imported", "프랑스") === "기타 수입산",
  );
  check("수입 이력 기록인데 원산지가 없으면 추론하지 않음", resolveTraceOrigin("mtrace_imported", null) === null);
  check("출처를 모르면 추론하지 않음", resolveTraceOrigin(null, null) === null);

  // 화면에서 실제로 어떻게 쓰이는지까지 확인한다.
  const report = buildScanRequirementReport(
    facts({
      apiOrigin: resolveTraceOrigin("mtrace_livestock", null),
      productOrigin: null,
      productId: null,
      productName: null,
    }),
  );

  check(
    "국내 이력 기록만으로 원산지가 채워지고 출처는 이력조회",
    field(report, "origin")?.value === "국내산" && field(report, "origin")?.source === "TRACE_API",
    JSON.stringify(field(report, "origin")),
  );
}

// 8) 축종 — 이력조회로만 채워지고, 부위 없이도(소는 부위를 안 줌) 상품을
//    고르기 전에 뭘 고르는 건지 알 수 있어야 한다.
{
  const withSpecies = buildScanRequirementReport(facts({ apiSpecies: "돼지" }));

  check(
    "축종이 있으면 이력조회 출처로 표시",
    field(withSpecies, "species")?.value === "돼지" &&
      field(withSpecies, "species")?.source === "TRACE_API",
  );
  check("축종은 권장이라 필수 누락으로 안 셈", withSpecies.missingRequired === 0);

  const noSpecies = buildScanRequirementReport(facts({ apiSpecies: null, traceFound: true }));

  check(
    "이력조회는 됐는데 축종 필드가 없으면 그 사실을 안내",
    field(noSpecies, "species")?.hint === "이력조회에 축종 정보가 없습니다.",
  );

  const notFound = buildScanRequirementReport(
    facts({ apiSpecies: null, traceFound: false }),
  );

  check(
    "이력조회 자체가 실패했으면 다른 안내",
    field(notFound, "species")?.hint?.includes("찾지 못했") === true,
  );
}

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log("\n전부 통과");
