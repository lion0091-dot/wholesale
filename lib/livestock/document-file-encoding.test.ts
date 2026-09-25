import { describe, expect, it } from "vitest";
import { parseDocumentText } from "./document-parser";
import { decodeDocumentFileText } from "./document-file-text";

/** KS X 1001 한글 영역(0xB0A1~0xC8FE)을 디코드해 글자→바이트 표를 만든다 — 테스트용 CP949(EUC-KR) 인코더. */
function eucKrEncode(text: string): Uint8Array {
  const decoder = new TextDecoder("euc-kr");
  const table = new Map<string, [number, number]>();

  for (let hi = 0xb0; hi <= 0xc8; hi += 1) {
    for (let lo = 0xa1; lo <= 0xfe; lo += 1) {
      const ch = decoder.decode(new Uint8Array([hi, lo]));

      if (ch.length === 1 && ch !== "�") table.set(ch, [hi, lo]);
    }
  }

  const bytes: number[] = [];

  for (const ch of text) {
    const pair = table.get(ch);

    if (pair) bytes.push(pair[0], pair[1]);
    else bytes.push(ch.charCodeAt(0));
  }

  return new Uint8Array(bytes);
}

const CSV = ["품목,이력번호,중량,단가,금액", "안심,002123456781,7.1,90000,639000", "채끝,002123456792,9.8,70000,686000"].join("\r\n");

describe("명세서 CSV — 폰 파일함에서 고른 파일의 인코딩", () => {
  it("UTF-8 CSV는 품목·번호가 그대로 읽힌다(PC에서 시험한 것과 같은 조건)", () => {
    const grid = parseDocumentText(new TextDecoder("utf-8").decode(new TextEncoder().encode(CSV)));

    expect(JSON.stringify(grid)).toContain("안심");
    expect(JSON.stringify(grid)).toContain("002123456781");
  });

  it("UTF-8 BOM이 붙은 CSV(엑셀 'CSV UTF-8')도 첫 칸 이름이 깨지지 않는다", () => {
    const withBom = "﻿" + CSV;
    const grid = parseDocumentText(withBom);

    expect(grid.cells[0][0]).toBe("품목");
  });

  it("CP949(EUC-KR) CSV — 한국 엑셀 'CSV(쉼표로 분리)' 기본값 — 을 UTF-8로만 읽으면 글자가 깨진다(예전 동작)", () => {
    const decodedAsUtf8 = new TextDecoder("utf-8").decode(eucKrEncode(CSV));

    expect(JSON.stringify(parseDocumentText(decodedAsUtf8))).toContain("�");
  });

  it("decodeDocumentFileText는 UTF-8은 그대로, CP949는 자동으로 알아봐서 품목명을 온전히 읽는다", () => {
    const utf8 = decodeDocumentFileText(new TextEncoder().encode(CSV));
    const cp949 = decodeDocumentFileText(eucKrEncode(CSV));
    const bom = decodeDocumentFileText(new TextEncoder().encode("﻿" + CSV));

    expect(utf8).toBe(CSV);
    expect(cp949).toBe(CSV);
    expect(parseDocumentText(cp949).cells[1][0]).toBe("안심");
    expect(parseDocumentText(bom).cells[0][0]).toBe("품목");
  });

  it("숫자·영문만 있는 ASCII CSV는 어느 쪽으로 읽어도 같다", () => {
    const ascii = ["item,trace", "A,002123456781"].join("\n");

    expect(decodeDocumentFileText(new TextEncoder().encode(ascii))).toBe(ascii);
  });
});
