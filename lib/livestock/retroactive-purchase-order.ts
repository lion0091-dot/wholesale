/**
 * "발주서 추가 생성"(마이그레이션 143) 결과 — 이미 재고에 들어간 박스를 사후에 발주서로 등록한 것.
 * owner/manager가 버튼을 눌러야만 만들어진다(사장님 원칙: 대표의 의사결정 없이는 발주서가 안 바뀐다).
 */
export interface RetroactivePurchaseOrderResult {
  orderId: string;
  lineId: string;
  /** 새 발주서 줄에 실린 무게(kg) — 이미 다른 발주서에 채워진 만큼을 뺀 나머지. */
  amount: number;
}

export function retroactivePurchaseOrderFromDb(raw: unknown): RetroactivePurchaseOrderResult {
  const row = (raw ?? {}) as Record<string, unknown>;

  return {
    orderId: String(row.order_id ?? ""),
    lineId: String(row.line_id ?? ""),
    amount: Number(row.amount ?? 0),
  };
}
