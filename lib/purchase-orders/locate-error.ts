/**
 * 저장 오류 문구를 보고 커서를 놓을 칸을 정한다. 줄 오류("3번째 줄: 수량(kg)은…")는 그 줄의 수량·단가·품목 칸, 머리 오류는 공급처·발주일·도착 예정일·메모 칸이다.
 * 줄 번호는 비어 있는 줄을 빼고 센 번호라서 화면상의 줄 위치(lineIndexes)로 되돌린다.
 */
export function locateSaveError(message: string, lineIndexes: number[]): { lineIndex: number | null; rowMessage: string | null; selector: string | null } {
  const rowMatch = message.match(/^(\d+)번째 줄: ([\s\S]*)$/);

  if (rowMatch) {
    const lineIndex = lineIndexes[Number(rowMatch[1]) - 1];

    if (lineIndex !== undefined) {
      const detail = rowMatch[2];
      const field = detail.includes("수량") ? "수량" : detail.includes("단가") ? "단가" : "품목";

      return { lineIndex, rowMessage: detail, selector: `[aria-label="${lineIndex + 1}번째 줄 ${field}"]` };
    }
  }

  const headerSelector = message.includes("공급처") || message.includes("거래처")
    ? "#po-supplier"
    : message.includes("도착 예정일")
      ? "#po-expected"
      : message.includes("발주일")
        ? "#po-ordered"
        : message.includes("메모")
          ? "#po-note"
          : message.includes("한 줄 이상")
            ? '[aria-label="1번째 줄 품목"]'
            : null;

  return { lineIndex: null, rowMessage: null, selector: headerSelector };
}
