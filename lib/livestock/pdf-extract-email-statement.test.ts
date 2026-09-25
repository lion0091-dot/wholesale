/**
 * 이메일로 받은 공급처 명세서 PDF를 폰 파일함에서 고르는 경우 — 글자가 든 표 PDF와 스캔본(글자 없음)을 실제 PDF로 만들어 읽어 본다.
 * 좌표로 칸을 복원하는 로직(빈 칸이 밀리지 않는지)이 핵심이다.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPdfTable } from "./pdf-extract";

const require = createRequire(import.meta.url);
const FONT = path.join(process.cwd(), "assets/fonts/NotoSansKR-Regular.ttf");

function buildPdf(draw: (doc: any) => void): Promise<Uint8Array> {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks: Buffer[] = [];

  doc.registerFont("kr", FONT);
  doc.font("kr");
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  return new Promise((resolve) => {
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    draw(doc);
    doc.end();
  });
}

const COLUMNS = [40, 170, 300, 370, 450];

function row(doc: any, y: number, cells: string[]) {
  cells.forEach((cell, index) => {
    if (cell) doc.fontSize(10).text(cell, COLUMNS[index], y, { lineBreak: false });
  });
}

describe("이메일 명세서 PDF (글자가 든 표)", () => {
  it("품목·이력번호·중량·단가·금액 칸을 복원하고, 이력번호가 빈 줄도 뒤 칸이 밀리지 않는다", async () => {
    const pdf = await buildPdf((doc) => {
      doc.fontSize(14).text("거래명세서 대성축산", 40, 40);
      row(doc, 90, ["품목", "이력번호", "중량", "단가", "금액"]);
      row(doc, 110, ["안심 1++", "002123456781", "7.10", "90,000", "639,000"]);
      row(doc, 130, ["채끝 1+", "002123456792", "9.80", "70,000", "686,000"]);
      row(doc, 150, ["부산물 모음", "", "5.00", "3,000", "15,000"]);
    });
    const table = await extractPdfTable(pdf);

    expect(table.hasText).toBe(true);
    expect(table.pageCount).toBe(1);

    const flat = table.cells.map((cells) => cells.join("|"));
    const header = table.cells.find((cells) => cells.includes("품목"));
    const blank = table.cells.find((cells) => cells.some((cell) => cell.includes("부산물")));

    expect(header).toBeDefined();
    expect(flat.some((line) => line.includes("002123456781") && line.includes("639,000"))).toBe(true);
    expect(blank).toBeDefined();
    // 이력번호 칸이 비었어도 중량(5.00)이 이력번호 자리로 밀려 들어가지 않는다
    expect(blank!.some((cell) => cell.includes("5.00"))).toBe(true);
    expect(blank!.join("|")).not.toMatch(/^부산물 모음\|5\.00/);
  });

  it("글자가 전혀 없는 PDF(스캔본·사진을 PDF로 바꾼 것)는 표가 비고 hasText=false — 원본 보관으로 넘어간다", async () => {
    const pdf = await buildPdf((doc) => {
      doc.rect(40, 40, 200, 100).fill("#cccccc");
    });
    const table = await extractPdfTable(pdf);

    expect(table.hasText).toBe(false);
    expect(table.cells).toHaveLength(0);
  });

  it("PDF가 아닌 파일은 읽기 함수가 예외를 던진다 — 서버 액션이 잡아 '원본만 보관'으로 넘긴다(scenarios.itest.ts SC-5)", async () => {
    await expect(extractPdfTable(new TextEncoder().encode("이건 PDF가 아닙니다"))).rejects.toThrow();
  });
});
