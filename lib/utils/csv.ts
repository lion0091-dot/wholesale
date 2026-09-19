/**
 * 브라우저에서 쓰는 최소한의 CSV 인코더/디코더. 청구서 목록 다운로드/업로드
 * (app/admin/billing/billing-invoice-list.tsx)와 은행 거래내역 대사 업로드가 같이 쓴다.
 */

/** 쉼표/따옴표/줄바꿈이 섞여도 안전하도록 최소한의 CSV 필드 이스케이프. */
export function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

/** 최소한의 RFC4180 스타일 CSV 파서(따옴표로 감싼 쉼표/줄바꿈 지원). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/**
 * 국내 은행 거래내역 CSV는 UTF-8이 아니라 EUC-KR(CP949)로 내려받히는 경우가 흔하다.
 * UTF-8로 먼저 디코드해보고 깨진 문자(U+FFFD)가 많으면 EUC-KR로 다시 시도한다.
 */
export function decodeCsvFile(buffer: ArrayBuffer): string {
  const utf8Text = new TextDecoder("utf-8").decode(buffer);
  const brokenCharCount = (utf8Text.match(/�/g) ?? []).length;

  if (brokenCharCount === 0) {
    return utf8Text;
  }

  try {
    return new TextDecoder("euc-kr").decode(buffer);
  } catch {
    return utf8Text;
  }
}
