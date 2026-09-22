/**
 * 원장 이벤트 표기. 화면과 필터가 같은 목록을 본다.
 *
 * Server Action 파일("use server")에서는 async 함수 외의 값을 export할 수 없어
 * 상수는 lib에 둔다 (lib/products/stock-adjust-reasons.ts와 같은 사정).
 */
export interface LedgerEventMeta {
  code: string;
  label: string;
  /** 목록 배지 색 */
  bg: string;
  color: string;
}

export const LEDGER_EVENTS: LedgerEventMeta[] = [
  { code: "INBOUND", label: "입고", bg: "#dcfce7", color: "#166534" },
  { code: "INBOUND_VOID", label: "입고취소", bg: "#f1f5f9", color: "#64748b" },
  { code: "OPENING_BALANCE", label: "기초재고", bg: "#e0e7ff", color: "#3730a3" },
  { code: "ORDER_OUT", label: "출고", bg: "#dbeafe", color: "#1e40af" },
  { code: "ORDER_RESTORE", label: "출고취소", bg: "#f1f5f9", color: "#64748b" },
  { code: "OUTBOUND_ASSIGN", label: "출고(스캔)", bg: "#dbeafe", color: "#1e40af" },
  { code: "OUTBOUND_UNASSIGN", label: "배정정정", bg: "#f1f5f9", color: "#64748b" },
  { code: "ADJUSTMENT", label: "조정", bg: "#fef3c7", color: "#92400e" },
  { code: "LOSS", label: "손실", bg: "#fee2e2", color: "#991b1b" },
];

const BY_CODE = new Map(LEDGER_EVENTS.map((event) => [event.code, event]));

export function ledgerEventMeta(code: string): LedgerEventMeta {
  return BY_CODE.get(code) ?? { code, label: code, bg: "#f1f5f9", color: "#64748b" };
}
