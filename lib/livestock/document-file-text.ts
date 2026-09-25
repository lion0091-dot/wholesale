/**
 * 서류 파일(CSV·TXT)의 바이트를 글자로 바꾼다.
 *
 * 이메일로 받은 명세서 CSV는 한국 엑셀이 "CSV(쉼표로 분리)"로 저장한 CP949(EUC-KR)인 경우가 많다.
 * 브라우저의 File.text()는 UTF-8로만 읽어 품목명이 깨지고, 깨진 부위 이름으로 상품이 자동 생성될 수 있다.
 * 그래서 UTF-8로 온전히 읽히면 그대로 쓰고, 아니면 EUC-KR(윈도우 949)로 다시 읽는다.
 */
export function decodeDocumentFileText(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}
