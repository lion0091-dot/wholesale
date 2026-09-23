/**
 * PDF 표 복원 확인.
 *
 * 실제 공급처 명세서를 아직 못 구해서, 이 저장소가 이미 쓰는 @react-pdf/renderer로
 * 표 모양 PDF를 만들어 검증한다. 핵심은 **칸이 비어 있는 줄**이다 — 글자만
 * 이어붙이는 방식이 무너지는 지점이라 반드시 확인해야 한다.
 *
 *   npx tsc --outDir .tsbuild --module commonjs --target es2022 \
 *     --moduleResolution node --skipLibCheck --esModuleInterop scripts/test-pdf-extract.ts
 *   node .tsbuild/scripts/test-pdf-extract.js
 */

import path from "node:path";
import React from "react";
import { Document, Page, Text, View, Font, renderToBuffer } from "@react-pdf/renderer";
import { extractPdfTable } from "../lib/livestock/pdf-extract";
import { applyColumnMap, buildGrid } from "../lib/livestock/document-parser";

const ROOT = process.cwd();

Font.register({
  family: "NotoSansKR",
  fonts: [
    { src: path.join(ROOT, "assets/fonts/NotoSansKR-Regular.ttf") },
    { src: path.join(ROOT, "assets/fonts/NotoSansKR-Bold.ttf"), fontWeight: 700 },
  ],
});
Font.registerHyphenationCallback((word) => [word]);

/** 3번째 줄은 이력번호 칸이 비어 있다 — 여기서 칸이 밀리면 안 된다. */
const ROWS = [
  ["품목", "이력번호", "중량(kg)", "단가", "금액"],
  ["한우 등심 1++", "002191840078", "8.20", "52,000", "426,400"],
  ["한우 채끝 1+", "002141592286", "7.50", "41,000", "307,500"],
  ["삼겹살", "", "12.40", "18,000", "223,200"],
  ["합계", "", "28.10", "", "957,100"],
];

const COLUMN_WIDTHS = [140, 110, 70, 70, 80];

async function main() {
  const doc = React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "A4", style: { padding: 30, fontFamily: "NotoSansKR", fontSize: 10 } },
      React.createElement(Text, { style: { fontSize: 14, marginBottom: 12 } }, "거래명세서"),
      React.createElement(
        Text,
        { style: { marginBottom: 8 } },
        "공급처: 대성축산   일자: 2026-09-23",
      ),
      ...ROWS.map((row, index) =>
        React.createElement(
          View,
          { key: index, style: { flexDirection: "row", paddingVertical: 4 } },
          ...row.map((cell, cellIndex) =>
            React.createElement(
              Text,
              { key: cellIndex, style: { width: COLUMN_WIDTHS[cellIndex] } },
              cell,
            ),
          ),
        ),
      ),
    ),
  );

  const buffer = await renderToBuffer(doc);
  const table = await extractPdfTable(new Uint8Array(buffer));

  let failed = 0;

  const check = (label: string, condition: boolean, detail = "") => {
    if (condition) {
      console.log(`ok    ${label}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };

  check("글자가 있는 PDF로 인식", table.hasText);
  check("표를 복원함", table.cells.length > 0, `줄 ${table.cells.length}`);

  const grid = buildGrid(table.cells);

  check(
    "헤더 줄을 찾음",
    grid.headerRowIndex !== null,
    `headerRowIndex=${grid.headerRowIndex}`,
  );
  check(
    "품목·이력번호·중량·단가·금액 칸을 모두 잡음",
    grid.columnMap.itemName !== undefined &&
      grid.columnMap.traceNo !== undefined &&
      grid.columnMap.labeledWeight !== undefined &&
      grid.columnMap.unitPrice !== undefined &&
      grid.columnMap.amount !== undefined,
    JSON.stringify(grid.columnMap),
  );

  const lines = applyColumnMap(grid, grid.columnMap);

  check("합계 줄은 빠지고 품목 3줄만 남음", lines.length === 3, `줄 ${lines.length}`);

  const first = lines[0];

  check(
    "첫 줄 품목명이 조각나지 않음",
    first?.itemName === "한우 등심 1++",
    `실제 ${String(first?.itemName)}`,
  );
  check("첫 줄 이력번호", first?.traceNo === "002191840078", `실제 ${String(first?.traceNo)}`);
  check("첫 줄 중량", first?.labeledWeight === 8.2, `실제 ${String(first?.labeledWeight)}`);
  check("첫 줄 금액(천단위 쉼표)", first?.amount === 426400, `실제 ${String(first?.amount)}`);

  // 이 검사가 이 모듈의 존재 이유다.
  const third = lines[2];

  check(
    "이력번호가 빈 줄에서 칸이 밀리지 않음 — 이력번호 비어 있음",
    !third?.traceNo,
    `실제 ${String(third?.traceNo)}`,
  );
  check(
    "이력번호가 빈 줄에서 중량이 그대로 12.40",
    third?.labeledWeight === 12.4,
    `실제 ${String(third?.labeledWeight)}`,
  );
  check(
    "이력번호가 빈 줄에서 단가가 그대로 18,000",
    third?.unitPrice === 18000,
    `실제 ${String(third?.unitPrice)}`,
  );

  if (failed > 0) {
    console.log(`\n${failed}건 실패`);
    console.log("복원된 표:", JSON.stringify(table.cells, null, 2));
    process.exit(1);
  }

  console.log("\n전부 통과");
}

void main();
