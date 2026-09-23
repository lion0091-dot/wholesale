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
    purchaseUnitPrice: null,
    purchaseSupplier: null,
    traceFound: true,
    apiGrade: "1++",
    apiOrigin: "국내산",
    documentMatched: true,
    documentSupplier: "대성축산",
    documentGrade: "1++",
    documentOrigin: "국내산",
    documentUnitPrice: 52000,
    documentLabeledWeight: 8.2,
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

// 1) 이력조회와 명세서가 모두 붙으면 필수 항목이 전부 찬다.
{
  const report = buildScanRequirementReport(facts());

  check(
    "이력조회 + 명세서가 다 붙으면 빠진 필수 항목 없음",
    report.missingRequired === 0,
    JSON.stringify(report.fields.filter((f) => f.level === "REQUIRED" && !f.value)),
  );
  check("어긋난 항목도 없음", report.conflictCount === 0);
}

// 2) 값의 출처가 항목마다 드러나야 한다 — 이게 이 화면의 목적이다.
{
  const report = buildScanRequirementReport(facts());

  check("실중량은 스캔에서 온다", field(report, "weight")?.source === "SCAN");
  check("등급은 이력조회가 1순위", field(report, "grade")?.source === "TRACE_API");
  check("공급처는 명세서에서 온다", field(report, "supplier")?.source === "DOCUMENT");
  check("매입단가도 명세서에서", field(report, "unitPrice")?.source === "DOCUMENT");
}

// 3) 명세서가 아직 안 붙었으면 "명세서를 올리면 채워진다"고 안내한다.
{
  const report = buildScanRequirementReport(
    facts({
      documentMatched: false,
      documentSupplier: null,
      documentGrade: null,
      documentOrigin: null,
      documentUnitPrice: null,
      documentLabeledWeight: null,
    }),
  );

  check("명세서 미연결로 표시", report.documentMatched === false);
  check(
    "공급처가 비고 명세서를 올리라고 안내",
    !field(report, "supplier")?.value &&
      field(report, "supplier")?.hint?.includes("명세서를 올리면") === true,
    JSON.stringify(field(report, "supplier")),
  );
  check(
    "단가도 같은 안내",
    field(report, "unitPrice")?.hint?.includes("명세서를 올리면") === true,
  );
  check(
    "바코드 표기중량이 있으면 명세서 없이도 채워짐",
    field(report, "labeledWeight")?.value === "8.2kg" &&
      field(report, "labeledWeight")?.source === "SCAN",
  );
  check(
    "원산지는 이력조회가 채워서 여전히 있음",
    field(report, "origin")?.source === "TRACE_API",
  );
}

// 4) 명세서는 붙었는데 그 명세서에 단가가 없으면 공급처에 요청해야 한다.
{
  const report = buildScanRequirementReport(
    facts({ documentUnitPrice: null, purchaseUnitPrice: null }),
  );

  check(
    "명세서에도 단가가 없으면 공급처에 요청하라고 바뀜",
    field(report, "unitPrice")?.hint?.includes("공급처에 요청") === true,
    JSON.stringify(field(report, "unitPrice")),
  );
  check("빠진 필수 1건으로 셈", report.missingRequired === 1);
}

// 5) 이력조회와 명세서가 다른 말을 하면 그대로 드러낸다.
{
  const report = buildScanRequirementReport(
    facts({ apiGrade: "1+", documentGrade: "1++", apiOrigin: "국내산", documentOrigin: "미국산" }),
  );

  check(
    "등급 불일치가 드러남",
    field(report, "grade")?.conflict?.includes("1+") === true &&
      field(report, "grade")?.conflict?.includes("1++") === true,
    field(report, "grade")?.conflict ?? "",
  );
  check(
    "원산지 불일치도 드러남",
    field(report, "origin")?.conflict?.includes("미국산") === true,
    field(report, "origin")?.conflict ?? "",
  );
  check("어긋난 항목 2건", report.conflictCount === 2);
  check(
    "불일치여도 값 자체는 이력조회 쪽을 보여줌",
    field(report, "grade")?.value === "1+" && field(report, "grade")?.source === "TRACE_API",
  );
}

// 6) 원산지 우선순위 — 이력조회 > 명세서 > 연결된 상품.
{
  const viaDocument = buildScanRequirementReport(facts({ apiOrigin: null, traceFound: false }));
  const viaProduct = buildScanRequirementReport(
    facts({ apiOrigin: null, traceFound: false, documentOrigin: null }),
  );
  const nowhere = buildScanRequirementReport(
    facts({
      apiOrigin: null,
      traceFound: false,
      documentOrigin: null,
      productOrigin: null,
      productId: null,
      productName: null,
    }),
  );

  check("이력조회가 없으면 명세서가 받친다", viaDocument.fields.find((f) => f.key === "origin")?.source === "DOCUMENT");
  check("명세서도 없으면 연결된 상품이 받친다", viaProduct.fields.find((f) => f.key === "origin")?.source === "PRODUCT");
  check(
    "셋 다 없으면 비고 필수 누락",
    !nowhere.fields.find((f) => f.key === "origin")?.value && nowhere.missingRequired >= 1,
  );
}

// 7) 이력조회가 번호를 못 찾은 경우의 안내가 달라야 한다.
{
  const report = buildScanRequirementReport(
    facts({ traceFound: false, apiGrade: null, documentGrade: null }),
  );

  check(
    "이력조회 실패 시 등급 안내가 그 사실을 말함",
    field(report, "grade")?.hint?.includes("찾지 못했") === true,
    field(report, "grade")?.hint ?? "",
  );
  check("등급은 권장이라 필수 누락으로 안 셈", report.missingRequired === 0);
}

// 8) 상품 미연결은 사람이 골라야 하는 필수 항목이다.
{
  const report = buildScanRequirementReport(facts({ productId: null, productName: null }));

  check(
    "상품 미연결 → 값 없음 + 고르라고 안내",
    !field(report, "product")?.value &&
      field(report, "product")?.hint?.includes("골라주세요") === true,
  );
}

// 9) 국내 이력제에 번호가 있으면 원산지는 국내산이다.
//    실제 적재 레코드에서 origin_country가 비어 있는 것을 확인했고, 국내
//    이력제가 국내 사육·도축분만 다루기 때문에 성립하는 판정이다.
{
  check("국내 이력제 기록 + 빈 원산지 → 국내산", resolveTraceOrigin("mtrace_livestock", null) === "국내산");
  check(
    "API가 원산지를 명시했으면 그 값이 우선",
    resolveTraceOrigin("mtrace_imported", "미국") === "미국",
  );
  check("수입 이력 기록인데 원산지가 없으면 추론하지 않음", resolveTraceOrigin("mtrace_imported", null) === null);
  check("출처를 모르면 추론하지 않음", resolveTraceOrigin(null, null) === null);

  // 화면에서 실제로 어떻게 쓰이는지까지 확인한다.
  const report = buildScanRequirementReport(
    facts({
      apiOrigin: resolveTraceOrigin("mtrace_livestock", null),
      documentOrigin: null,
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

// 10) 축종 — 이력조회로만 채워지고, 부위 없이도(소는 부위를 안 줌) 상품을
//     고르기 전에 뭘 고르는 건지 알 수 있어야 한다.
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

// 11) 명세서 품목명 — 이력조회가 부위를 못 줘도 명세서 원문 품목명이 사람에게
//     부위를 알려주는 참고 정보가 돼야 한다.
{
  const withItemName = buildScanRequirementReport(
    facts({ apiSpecies: null, apiGrade: null, documentItemName: "채끝 1++" }),
  );

  check(
    "명세서 품목명이 있으면 명세서 출처로 그대로 표시",
    field(withItemName, "documentItemName")?.value === "채끝 1++" &&
      field(withItemName, "documentItemName")?.source === "DOCUMENT",
  );
  check("품목명은 권장이라 필수 누락으로 안 셈", withItemName.missingRequired === 0);

  const matchedNoItemName = buildScanRequirementReport(
    facts({ documentItemName: null, documentMatched: true }),
  );

  check(
    "명세서는 연결됐는데 품목명이 비어 있으면 그 사실을 안내",
    field(matchedNoItemName, "documentItemName")?.hint === "연결된 명세서 줄에 품목명이 비어 있습니다.",
  );

  const noDocument = buildScanRequirementReport(
    facts({
      documentItemName: null,
      documentMatched: false,
      documentSupplier: null,
      documentGrade: null,
      documentOrigin: null,
      documentUnitPrice: null,
      documentLabeledWeight: null,
    }),
  );

  check(
    "연결된 명세서 자체가 없으면 다른 안내",
    field(noDocument, "documentItemName")?.hint === "연결된 명세서가 없습니다.",
  );
}

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log("\n전부 통과");
