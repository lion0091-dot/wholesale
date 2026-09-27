import { describe, expect, it } from "vitest";
import { locateSaveError } from "./locate-error";

// 화면에서 2번째·4번째 줄만 채웠다면 서버가 세는 1·2번째 줄은 화면의 index 1·3이다.
const INDEXES = [1, 3];

describe("locateSaveError", () => {
  it("수량 오류는 그 줄의 수량 칸으로, 서버 줄 번호를 화면 줄 위치로 되돌린다", () => {
    expect(locateSaveError("2번째 줄: 수량(kg)은 0보다 큰 숫자여야 합니다.", INDEXES)).toEqual({
      lineIndex: 3,
      rowMessage: "수량(kg)은 0보다 큰 숫자여야 합니다.",
      selector: '[aria-label="4번째 줄 수량"]',
    });
  });

  it("단가 오류는 단가 칸으로", () => {
    expect(locateSaveError("1번째 줄: 단가는 0 이상의 숫자여야 합니다.", INDEXES)).toMatchObject({ lineIndex: 1, selector: '[aria-label="2번째 줄 단가"]' });
  });

  it("축종·품종·원산지 같은 스펙 오류는 그 줄의 품목 칸으로", () => {
    for (const detail of ["품종을 골라주세요. (한우, 육우, 젖소)", "원산지를 입력해주세요.", "축종을 골라주세요.", "선택한 품목을 찾을 수 없습니다(보관됐거나 삭제됨). 다시 골라주세요."]) {
      expect(locateSaveError(`1번째 줄: ${detail}`, INDEXES)).toMatchObject({ lineIndex: 1, selector: '[aria-label="2번째 줄 품목"]' });
    }
  });

  it("머리 오류는 공급처·발주일·도착 예정일·메모 칸으로, 줄 오류가 아니라 줄 표시는 없다", () => {
    expect(locateSaveError("공급처를 목록에서 골라주세요.", INDEXES)).toEqual({ lineIndex: null, rowMessage: null, selector: "#po-supplier" });
    expect(locateSaveError("선택한 공급처를 찾을 수 없습니다.", INDEXES).selector).toBe("#po-supplier");
    expect(locateSaveError("발주일을 입력해주세요.", INDEXES).selector).toBe("#po-ordered");
    expect(locateSaveError("도착 예정일은 발주일보다 빠를 수 없습니다.", INDEXES).selector).toBe("#po-expected");
    expect(locateSaveError("메모는 500자 이내로 입력해주세요.", INDEXES).selector).toBe("#po-note");
    expect(locateSaveError("발주할 품목을 한 줄 이상 입력해주세요.", INDEXES).selector).toBe('[aria-label="1번째 줄 품목"]');
  });

  it("어느 칸인지 알 수 없는 오류나 범위 밖 줄 번호는 커서를 옮기지 않는다", () => {
    expect(locateSaveError("저장에 실패했습니다.", INDEXES)).toEqual({ lineIndex: null, rowMessage: null, selector: null });
    expect(locateSaveError("9번째 줄: 수량(kg)은 0보다 큰 숫자여야 합니다.", INDEXES).lineIndex).toBeNull();
  });
});
