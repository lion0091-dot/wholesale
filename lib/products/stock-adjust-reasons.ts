/**
 * 재고 조정 사유 목록.
 *
 * Server Action 파일("use server")에서는 async 함수 외의 값을 export할 수 없어서
 * (Next.js 빌드 에러) 상수는 여기로 분리한다. 화면과 서버 액션이 같은 목록을 본다.
 *
 * 폐기·파손으로 줄어든 건은 DB에서 LOSS로 따로 기록돼 나중에 손실률 집계에 쓴다
 * (adjust_product_stock, 20260930000055).
 */
export const STOCK_ADJUST_REASONS = [
  { code: "STOCKTAKE", label: "재고 실사" },
  { code: "DISPOSAL", label: "폐기" },
  { code: "DAMAGE", label: "파손·손실" },
  { code: "RETURN", label: "반품 입고" },
  { code: "OTHER", label: "기타" },
] as const;

export type StockAdjustReasonCode = (typeof STOCK_ADJUST_REASONS)[number]["code"];

export const STOCK_ADJUST_REASON_CODES: string[] = STOCK_ADJUST_REASONS.map(
  (reason) => reason.code
);
