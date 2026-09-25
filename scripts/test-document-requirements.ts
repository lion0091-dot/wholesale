/**
 * 명세서 미흡 항목 판정 확인.
 *
 *   npx tsc --outDir <out> --module commonjs --target es2022 --moduleResolution node \
 *     --skipLibCheck scripts/test-document-requirements.ts
 *   node <out>/scripts/test-document-requirements.js
 */

import { buildGapReport, buildSupplierRequestSummary } from "../lib/livestock/document-requirements";
import type { DocumentLine } from "../lib/livestock/document-parser";

function line(overrides: Partial<DocumentLine> = {}): DocumentLine {
  return {
    lineNo: 1,
    raw: "",
    itemName: "한우 등심",
    traceNo: "002191840078",
    lotNo: null,
    traceTruncated: false,
    splitOf: null,
    partName: null,
    grade: "1++",
    origin: "국내산",
    quantity: null,
    labeledWeight: 8.2,
    unitPrice: 52000,
    amount: 426400,
    ...overrides,
  };
}

const header = { supplierName: "대성축산", issuedOn: "2026-09-23", totalAmount: null };
const linked = [{ lineNo: 1, productId: "prod-1", productOrigin: "국내산" }];

let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1) 다 갖춘 줄은 아무것도 안 걸린다.
{
  const report = buildGapReport(header, [line()], linked);
  check(
    "다 갖춘 줄은 미흡 항목 없음",
    report.lineGaps.length === 0 && report.documentGaps.length === 0,
    JSON.stringify(report.lineGaps),
  );
}

// 2) 이력번호는 스캔이 채우므로 권장 수준이고, 채울 주체가 창고다.
{
  const report = buildGapReport(header, [line({ traceNo: null })], linked);
  const gap = report.lineGaps[0]?.gaps.find((g) => g.code === "TRACE_MISSING");

  check(
    "이력번호 없음 → 권장 + 창고 스캔이 채움",
    gap?.level === "RECOMMENDED" && gap?.source === "FROM_SCAN",
    JSON.stringify(gap),
  );
  check("이력번호만 빠진 줄은 미완성으로 세지 않음", report.incompleteLineCount === 0);
}

// 3) 중량은 공급처에 요청해야 하는 필수 항목.
{
  const report = buildGapReport(header, [line({ labeledWeight: null })], linked);
  const gap = report.lineGaps[0]?.gaps.find((g) => g.code === "WEIGHT_MISSING");

  check(
    "중량 없음 → 필수 + 공급처에 요청",
    gap?.level === "REQUIRED" && gap?.source === "FROM_SUPPLIER",
    JSON.stringify(gap),
  );
  check("필수가 빠지면 미완성 줄로 셈", report.incompleteLineCount === 1);
}

// 4) 단가와 금액 중 하나만 있으면 나머지는 계산 가능 → 미흡 아님.
{
  const onlyUnit = buildGapReport(header, [line({ amount: null })], linked);
  const onlyAmount = buildGapReport(header, [line({ unitPrice: null })], linked);
  const neither = buildGapReport(header, [line({ unitPrice: null, amount: null })], linked);

  check(
    "단가만 있어도 금액 계산 가능 → 미흡 아님",
    !onlyUnit.lineGaps[0]?.gaps.some((g) => g.code === "PRICE_MISSING"),
  );
  check(
    "금액만 있어도 미흡 아님",
    !onlyAmount.lineGaps[0]?.gaps.some((g) => g.code === "PRICE_MISSING"),
  );
  check(
    "둘 다 없으면 필수 누락",
    neither.lineGaps[0]?.gaps.some(
      (g) => g.code === "PRICE_MISSING" && g.level === "REQUIRED",
    ) === true,
  );
}

// 5) 상품 연결은 공급사가 화면에서 고르는 것.
{
  const report = buildGapReport(header, [line()], []);
  const gap = report.lineGaps[0]?.gaps.find((g) => g.code === "PRODUCT_UNLINKED");

  check(
    "상품 미연결 → 필수 + 공급사가 화면에서 지정",
    gap?.level === "REQUIRED" && gap?.source === "FROM_STAFF",
    JSON.stringify(gap),
  );
}

// 6) 품목도 이력번호도 없으면 상품 고르라는 말조차 못 한다.
{
  const report = buildGapReport(header, [line({ itemName: null, traceNo: null })], []);
  const codes = report.lineGaps[0]?.gaps.map((g) => g.code) ?? [];

  check(
    "품목·이력번호 둘 다 없으면 ITEM_UNKNOWN (상품선택 요구가 아님)",
    codes.includes("ITEM_UNKNOWN") && !codes.includes("PRODUCT_UNLINKED"),
    codes.join(","),
  );
}

// 7) 문서 단위 — 공급처명이 비면 필수.
{
  const report = buildGapReport({ supplierName: "  ", issuedOn: null }, [line()], linked);
  const codes = report.documentGaps.map((g) => g.code);

  check("공급처명 없음 → 문서 단위 필수", codes.includes("SUPPLIER_MISSING"));
  check("서류 날짜 없음 → 권장", codes.includes("ISSUED_ON_MISSING"));
}

// 8) 서류 합계와 줄 합계가 다르면 잘못 읽었을 수 있다고 짚는다.
{
  const ok = buildGapReport({ ...header, totalAmount: 426400 }, [line()], linked);
  const bad = buildGapReport({ ...header, totalAmount: 999999 }, [line()], linked);

  check("합계가 맞으면 조용함", !ok.documentGaps.some((g) => g.code === "TOTAL_MISMATCH"));
  check("합계가 다르면 경고", bad.documentGaps.some((g) => g.code === "TOTAL_MISMATCH"));
}

// 9) 줄이 하나도 안 읽히면 문서 단위로 알린다.
{
  const report = buildGapReport(header, [], []);

  check("줄 0개 → NO_LINES", report.documentGaps.some((g) => g.code === "NO_LINES"));
}

// 10) 공급처에 요청할 것만 추려낸다 (중복 제거).
{
  const report = buildGapReport({ supplierName: "대성축산", issuedOn: "2026-09-23" }, [
    line({ lineNo: 1, labeledWeight: null }),
    line({ lineNo: 2, labeledWeight: null, unitPrice: null, amount: null }),
  ], [
    { lineNo: 1, productId: "p1" },
    { lineNo: 2, productId: "p2" },
  ]);
  const summary = buildSupplierRequestSummary(report);

  check(
    "공급처 요청 목록은 중복 없이 2종",
    summary.length === 2,
    JSON.stringify(summary),
  );
  check(
    "공급사·창고가 채울 항목은 요청 목록에서 빠짐",
    !summary.some((text) => text.includes("이력번호") || text.includes("골라주세요")),
    JSON.stringify(summary),
  );
}

// 11) 등급 — 그 자체로 필수는 아니다. 이력번호가 있으면 공공조회가 채운다.
//     둘 다 없을 때만 짚는다 (사장님 확정 2026-09-23).
{
  const hasTrace = buildGapReport(header, [line({ grade: null })], linked);
  const hasGrade = buildGapReport(header, [line({ traceNo: null })], linked);
  const neither = buildGapReport(header, [line({ grade: null, traceNo: null })], linked);

  check(
    "등급 없어도 이력번호가 있으면 안 짚음",
    !hasTrace.lineGaps[0]?.gaps.some((g) => g.code === "GRADE_UNKNOWN"),
    JSON.stringify(hasTrace.lineGaps[0]?.gaps.map((g) => g.code)),
  );
  check(
    "이력번호 없어도 등급이 있으면 안 짚음",
    !hasGrade.lineGaps[0]?.gaps.some((g) => g.code === "GRADE_UNKNOWN"),
  );

  const gap = neither.lineGaps[0]?.gaps.find((g) => g.code === "GRADE_UNKNOWN");

  check(
    "둘 다 없으면 권장 + 공급처에 요청",
    gap?.level === "RECOMMENDED" && gap?.source === "FROM_SUPPLIER",
    JSON.stringify(gap),
  );
  check("등급은 필수가 아니므로 미완성 줄로 세지 않음", neither.incompleteLineCount === 0);
}

// 12) 원산지 — 필수지만 알 수 있는 경로가 셋이라 셋 다 막혔을 때만 걸린다.
{
  const viaTrace = buildGapReport(header, [line({ origin: null })], linked);
  const viaProduct = buildGapReport(header, [line({ origin: null, traceNo: null })], linked);
  const nothing = buildGapReport(header, [line({ origin: null, traceNo: null })], []);

  check(
    "원산지 없어도 이력번호가 있으면 안 짚음",
    !viaTrace.lineGaps[0]?.gaps.some((g) => g.code === "ORIGIN_UNKNOWN"),
  );
  check(
    "이력번호 없어도 상품이 연결됐으면 안 짚음",
    !viaProduct.lineGaps[0]?.gaps.some((g) => g.code === "ORIGIN_UNKNOWN"),
  );

  const gap = nothing.lineGaps[0]?.gaps.find((g) => g.code === "ORIGIN_UNKNOWN");

  check(
    "셋 다 없으면 필수 누락 + 공급처에 요청",
    gap?.level === "REQUIRED" && gap?.source === "FROM_SUPPLIER",
    JSON.stringify(gap),
  );
}

// 13) 서류 원산지와 고른 상품의 원산지가 다르면 상품을 잘못 고른 것이다.
//     그대로 두면 수입육이 국내산 상품 재고로 들어가 원산지 허위표시가 된다.
{
  const mismatch = buildGapReport(header, [line({ origin: "미국산" })], linked);
  const gap = mismatch.lineGaps[0]?.gaps.find((g) => g.code === "ORIGIN_MISMATCH");

  check(
    "원산지 불일치 → 필수 + 공급사가 상품을 다시 고름",
    gap?.level === "REQUIRED" && gap?.source === "FROM_STAFF",
    JSON.stringify(gap),
  );
  check(
    "불일치 문구에 양쪽 원산지가 모두 보임",
    Boolean(gap && gap.label.includes("미국산") && gap.label.includes("국내산")),
    gap?.label,
  );
  check(
    "원산지가 같으면 조용함",
    !buildGapReport(header, [line()], linked).lineGaps.some((l) =>
      l.gaps.some((g) => g.code === "ORIGIN_MISMATCH"),
    ),
  );
}

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log("\n전부 통과");
