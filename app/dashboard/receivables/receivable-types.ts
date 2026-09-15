/** 미수금 정산 화면이 공유하는 모델 — 거래처별로 미정산 외상 주문을 묶어서 보여준다 */
export interface ReceivableOrderRow {
  id: string;
  orderNumber: string;
  totalAmount: number;
  orderedAt: string;
  dueAt: string;
  isOverdue: boolean;
}

export interface ReceivableCustomerGroup {
  retailerId: string;
  restaurantName: string;
  creditLimit: number;
  outstandingBalance: number;
  settlementDueDays: number;
  orders: ReceivableOrderRow[];
}
