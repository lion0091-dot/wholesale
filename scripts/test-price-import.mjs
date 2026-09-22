/**
 * 판매가 일괄 등록 CSV 만들기/읽기 확인.
 *   node scripts/test-price-import.mjs
 */
import { evaluateModules } from "./lib-strip-types.mjs";

const module = "lib/products/price-import.ts";
const buildPriceCsv = evaluateModules([module], "buildPriceCsv");
const parsePriceCsv = evaluateModules([module], "parsePriceCsv");

const products = [
  {
    id: "cccccccc-0000-0000-0000-000000000001",
    name: "한우 등심 1++",
    category: "소",
    subcategory: "등심",
    grade: "1++",
    unit: "kg",
    basePrice: 0,
    marketPrice: 26980,
  },
  {
    id: "cccccccc-0000-0000-0000-000000000002",
    name: '수입 삼겹살, "특"',
    category: "돼지",
    subcategory: "삼겹살",
    grade: null,
    unit: "kg",
    basePrice: 0,
    marketPrice: null,
  },
];

let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    console.log(`✅ ${label}${detail ? ` → ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`❌ ${label}${detail ? ` → ${detail}` : ""}`);
  }
};

const csv = buildPriceCsv(products);

check("BOM 포함(엑셀 한글 깨짐 방지)", csv.startsWith("﻿"));
check("머리글에 상품ID·판매가 있음", csv.includes("상품ID") && csv.includes("판매가"));
check("쉼표·따옴표 든 이름이 감싸짐", csv.includes('"수입 삼겹살, ""특"""'));

// 사용자가 판매가 칸을 채운 상황
const filled = csv
  .replace("cccccccc-0000-0000-0000-000000000001,한우 등심 1++,소,등심,1++,kg,0,26980,", "cccccccc-0000-0000-0000-000000000001,한우 등심 1++,소,등심,1++,kg,0,26980,68000")
  .replace(/,,\n?$/m, ",");

const parsed = parsePriceCsv(filled);
check("채운 줄 1건 인식", parsed.filledCount === 1, `filled=${parsed.filledCount}`);
check("오류 줄 없음", parsed.errorCount === 0, `errors=${parsed.errorCount}`);
check(
  "가격 파싱",
  parsed.rows[0]?.price === 68000,
  String(parsed.rows[0]?.price)
);

// 쉼표 섞인 금액 표기
const withComma = parsePriceCsv('상품ID,상품명,판매가\ncccccccc-0000-0000-0000-000000000001,한우,"68,000"');
check("68,000 표기 파싱", withComma.rows[0]?.price === 68000, String(withComma.rows[0]?.price));

// 머리글이 없는 파일
const badHeader = parsePriceCsv("아무거나,값\n1,2");
check("머리글 없으면 오류 안내", badHeader.errorCount === 1 && badHeader.rows[0].error !== null);

// ID가 망가진 줄
const badId = parsePriceCsv("상품ID,판매가\n망가진값,68000");
check("잘못된 ID는 오류로 표시", badId.rows[0]?.error !== null);

// 빈 칸은 건너뜀
const empty = parsePriceCsv("상품ID,판매가\ncccccccc-0000-0000-0000-000000000001,");
check("빈 칸은 건너뜀", empty.filledCount === 0 && empty.errorCount === 0);

if (failed > 0) {
  console.log(`\n${failed}건 실패`);
  process.exit(1);
}

console.log("\n전부 통과");
