/**
 * 엑셀 대량 입고용 표 파싱.
 *
 * npm 레지스트리가 이 환경에서 막혀 SheetJS 같은 .xlsx 파서를 넣을 수 없다.
 * 대신 두 경로를 받는다 — 둘 다 엑셀에서 바로 나온다:
 *   ① CSV 파일 업로드 (엑셀 > 다른 이름으로 저장 > CSV)
 *   ② 엑셀에서 범위를 복사해 붙여넣기 (탭 구분 TSV)
 *
 * 구분자는 첫 줄을 보고 자동 판별한다. 헤더가 있으면 건너뛴다.
 * 이력번호는 GS1-128/QR로 들어와도 되게 barcode-parser를 태운다 — 엑셀에
 * 스캐너로 찍어 넣은 값이 그대로 들어있는 경우가 흔하다.
 */

import { parseBarcode } from "./barcode-parser";

export interface ImportRow {
  /** 1부터 시작하는 원본 줄 번호 — 오류를 사용자에게 알려줄 때 쓴다 */
  rowNo: number;
  traceNo: string;
  weight: number | null;
  /** 이 줄을 처리할 수 없는 이유 (있으면 업로드에서 제외) */
  error: string | null;
  raw: string;
}

export interface ParsedImport {
  rows: ImportRow[];
  validCount: number;
  errorCount: number;
}

/** 첫 줄에 탭이 있으면 엑셀 붙여넣기, 아니면 CSV로 본다. */
function detectDelimiter(firstLine: string): string {
  if (firstLine.includes("\t")) return "\t";
  if (firstLine.includes(";")) return ";";

  return ",";
}

/** 따옴표로 감싼 칸 안의 구분자를 지키면서 한 줄을 쪼갠다. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      // 따옴표 안의 "" 는 따옴표 한 개를 뜻한다.
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);

  return cells.map((cell) => cell.trim());
}

/** 헤더 줄인지 — 첫 칸에서 이력번호를 못 뽑고 글자가 섞여 있으면 헤더로 본다. */
function looksLikeHeader(cells: string[]): boolean {
  const first = cells[0] ?? "";

  if (!first) return false;

  return parseBarcode(first).traceNo === null && /[가-힣A-Za-z]/.test(first);
}

/** "8.2", "8.2kg", "8,200" 같은 표기를 숫자로 바꾼다. */
function parseWeight(value: string): number | null {
  const cleaned = value.replace(/[^\d.]/g, "");

  if (!cleaned) return null;

  const parsed = Number.parseFloat(cleaned);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseImportTable(text: string): ParsedImport {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return { rows: [], validCount: 0, errorCount: 0 };
  }

  const delimiter = detectDelimiter(lines[0]);
  const rows: ImportRow[] = [];

  lines.forEach((line, index) => {
    const cells = splitLine(line, delimiter);

    // 첫 줄이 헤더면 건너뛴다.
    if (index === 0 && looksLikeHeader(cells)) {
      return;
    }

    const parsed = parseBarcode(cells[0] ?? "");
    // 중량은 둘째 칸을 먼저 보고, 없으면 바코드에 실려 있던 값을 쓴다.
    const weight = parseWeight(cells[1] ?? "") ?? parsed.weightKg;

    let error: string | null = null;

    if (!parsed.traceNo) {
      error = "이력번호를 읽을 수 없습니다";
    } else if (!weight) {
      error = "중량이 없습니다";
    }

    rows.push({
      rowNo: index + 1,
      traceNo: parsed.traceNo ?? (cells[0] ?? "").trim(),
      weight,
      error,
      raw: line,
    });
  });

  return {
    rows,
    validCount: rows.filter((row) => !row.error).length,
    errorCount: rows.filter((row) => row.error).length,
  };
}
