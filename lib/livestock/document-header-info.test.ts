import { describe, expect, it } from "vitest";
import { extractDocumentNo } from "./document-header-info";

describe("extractDocumentNo", () => {
  it("'전표번호: 값'처럼 한 칸에 붙은 모양을 읽는다", () => {
    expect(extractDocumentNo([["대성축산 거래명세서"], ["전표번호: A-100"], ["품목", "중량"], ["등심", "10"]], 2)).toBe("A-100");
  });

  it("라벨 칸 옆 칸의 값을 읽는다(엑셀·PDF 표 모양)", () => {
    expect(extractDocumentNo([["", "명세서 No.", "20260926-001", ""], ["품목", "중량"]], 1)).toBe("20260926-001");
    expect(extractDocumentNo([["거래명세서번호", "", "B7712"], ["품목", "중량"]], 1)).toBe("B7712");
  });

  it("이력번호·묶음번호·일련번호·사업자등록번호 칸은 전표번호로 읽지 않는다", () => {
    expect(extractDocumentNo([["이력번호", "002191840011"], ["묶음번호", "L20260926000101"], ["번호", "1"], ["사업자등록번호", "123-45-67890"]], null)).toBeNull();
  });

  it("품목 표 안(헤더 줄 아래)의 값은 보지 않는다", () => {
    expect(extractDocumentNo([["품목", "전표번호"], ["등심", "전표번호: X-999"]], 0)).toBeNull();
  });

  it("값이 없거나 너무 짧으면 null이다", () => {
    expect(extractDocumentNo([["전표번호:"], ["품목"]], 1)).toBeNull();
    expect(extractDocumentNo([["전표번호: 1"], ["품목"]], 1)).toBeNull();
    expect(extractDocumentNo([], null)).toBeNull();
  });

  it("샘플 전표처럼 머리글이 없는 파일은 null이라 사람이 적는다", () => {
    expect(extractDocumentNo([["품목", "부위", "이력번호"], ["한우 등심", "등심", "002191840011"]], 0)).toBeNull();
  });
});
