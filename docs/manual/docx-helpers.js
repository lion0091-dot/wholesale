const fs = require("fs");
const path = require("path");
const d = require("docx");
const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, HeadingLevel, LevelFormat, BorderStyle, Footer, PageNumber } = d;

const FONT = "Malgun Gothic";
const W = 9638; // content width (A4, 2cm margins)

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: 22, ...o });
const P = (text, o = {}) => new Paragraph({ spacing: { after: 120, line: 320 }, ...o, children: Array.isArray(text) ? text : [run(text)] });
const B = (text) => new Paragraph({ numbering: { reference: "bul", level: 0 }, spacing: { after: 60, line: 300 }, children: Array.isArray(text) ? text : [run(text)] });
const N = (text, ref = "num") => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 80, line: 300 }, children: Array.isArray(text) ? text : [run(text)] });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 }, children: [new TextRun({ text: t, font: FONT, size: 30, bold: true })] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: t, font: FONT, size: 25, bold: true })] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 }, children: [new TextRun({ text: t, font: FONT, size: 23, bold: true })] });
const bold = (t) => run(t, { bold: true });

const border = { style: BorderStyle.SINGLE, size: 4, color: "94A3B8" };
const borders = { top: border, bottom: border, left: border, right: border };

function cell(text, width, o = {}) {
  const parts = Array.isArray(text) ? text : [run(text, o.bold ? { bold: true } : {})];
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    children: [new Paragraph({ spacing: { line: 290 }, children: parts })],
  });
}

function table(widths, header, rows) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, widths[i], { bold: true, fill: "E2E8F0" })) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, widths[i])) })),
    ],
  });
}

function box(title, lines, fill = "FEF3C7") {
  return new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: [W],
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: W, type: WidthType.DXA },
            borders,
            shading: { fill, type: ShadingType.CLEAR, color: "auto" },
            margins: { top: 110, bottom: 110, left: 160, right: 160 },
            children: [
              new Paragraph({ spacing: { after: 80 }, children: [bold(title)] }),
              ...lines.map((l) => new Paragraph({ spacing: { after: 60, line: 300 }, children: [run(l)] })),
            ],
          }),
        ],
      }),
    ],
  });
}

const why = (lines) => box("왜 이 단계가 필요할까요?", lines, "DBEAFE");
const gap = () => new Paragraph({ spacing: { after: 100 }, children: [] });

/** PNG의 IHDR 청크에서 가로·세로 픽셀 값을 읽는다(라이브러리 없이 실제 비율대로 넣기 위함). */
function pngSize(filePath) {
  const buf = fs.readFileSync(filePath);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), data: buf };
}

/** 화면 캡처 한 장 + 설명 캡션. 문서 본문 폭(W)을 안 넘게 자동으로 줄인다. */
function figure(filePath, caption, maxWidthPx = 620) {
  const { width, height, data } = pngSize(filePath);
  const w = Math.min(maxWidthPx, width);
  const h = Math.round((w / width) * height);

  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 40 },
      border: { top: border, bottom: border, left: border, right: border },
      children: [new ImageRun({ type: "png", data, transformation: { width: w, height: h } })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [run(caption, { size: 18, color: "64748B", italics: true })],
    }),
  ];
}


module.exports = { fs, path, d, Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, LevelFormat, Footer, PageNumber, FONT, W, run, P, B, N, H1, H2, H3, bold, table, box, why, gap, figure, border };
