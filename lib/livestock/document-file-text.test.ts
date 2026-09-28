import { describe, expect, it } from "vitest";
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

describe("decodeDocumentFileText — 엑셀 대량 입고 CSV의 인코딩", () => {
  it("UTF-8은 그대로 읽힌다", () => {
    expect(decodeDocumentFileText(new TextEncoder().encode(CSV))).toBe(CSV);
  });

  it("CP949(EUC-KR) — 한국 엑셀 'CSV(쉼표로 분리)' 기본값 — 도 자동으로 알아봐서 온전히 읽는다", () => {
    expect(decodeDocumentFileText(eucKrEncode(CSV))).toBe(CSV);
  });

  it("UTF-8 BOM이 붙은 CSV(엑셀 'CSV UTF-8')도 첫 글자가 깨지지 않는다(BOM은 디코더가 제거한다)", () => {
    const withBom = "﻿" + CSV;

    expect(decodeDocumentFileText(new TextEncoder().encode(withBom))).toBe(CSV);
  });

  it("숫자·영문만 있는 ASCII CSV는 어느 쪽으로 읽어도 같다", () => {
    const ascii = ["item,trace", "A,002123456781"].join("\n");

    expect(decodeDocumentFileText(new TextEncoder().encode(ascii))).toBe(ascii);
  });
});
