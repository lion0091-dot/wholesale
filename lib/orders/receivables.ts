/** 외상 주문의 정산 기한/연체 여부 계산 — 순수 함수 (서버/클라이언트 공용) */

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeDueAt(orderedAt: string, settlementDueDays: number): string {
  return new Date(new Date(orderedAt).getTime() + settlementDueDays * DAY_MS).toISOString();
}

export function isOverdue(dueAt: string, now: Date = new Date()): boolean {
  return new Date(dueAt).getTime() < now.getTime();
}

/** 미수금 정산 화면(전체·모바일 간이판 공용)이 공유하는 모델 — 거래처별로 미정산 외상 주문을 묶어서 보여준다 */
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

/** wholesaler_retailers 조회 응답 (거래처별 여신/연체 기준) */
export interface ReceivableRelationRow {
  retailer_id: string;
  credit_limit: number;
  outstanding_balance: number;
  settlement_due_days: number;
  retailers:
    | { restaurant_name: string }
    | Array<{ restaurant_name: string }>
    | null;
}

/** 미정산 외상 주문 조회 응답 */
export interface ReceivableCreditOrderRow {
  id: string;
  order_number: string;
  retailer_id: string;
  total_amount: number;
  ordered_at: string;
}

/**
 * 거래처별 미정산 외상 주문을 묶는다 — 전체 화면(receivables/page.tsx)과 모바일
 * 간이판(quick/settle/page.tsx)이 같은 쿼리 결과를 똑같은 기준으로 묶어야 해서 공용화했다.
 */
export function buildReceivableGroups(
  relations: ReceivableRelationRow[],
  creditOrders: ReceivableCreditOrderRow[]
): ReceivableCustomerGroup[] {
  const ordersByRetailer = new Map<string, ReceivableCreditOrderRow[]>();

  for (const order of creditOrders) {
    const list = ordersByRetailer.get(order.retailer_id) ?? [];
    list.push(order);
    ordersByRetailer.set(order.retailer_id, list);
  }

  const groups = relations.map((relation) => {
    const retailer = Array.isArray(relation.retailers) ? relation.retailers[0] : relation.retailers;
    const dueDays = relation.settlement_due_days;

    const orders: ReceivableOrderRow[] = (ordersByRetailer.get(relation.retailer_id) ?? [])
      .map((order) => {
        const dueAt = computeDueAt(order.ordered_at, dueDays);

        return {
          id: order.id,
          orderNumber: order.order_number,
          totalAmount: Number(order.total_amount),
          orderedAt: order.ordered_at,
          dueAt,
          isOverdue: isOverdue(dueAt),
        };
      })
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

    return {
      retailerId: relation.retailer_id,
      restaurantName: retailer?.restaurant_name ?? "이름 미등록 고객(소매)",
      creditLimit: Number(relation.credit_limit ?? 0),
      outstandingBalance: Number(relation.outstanding_balance ?? 0),
      settlementDueDays: dueDays,
      orders,
    };
  });

  // 미정산 외상 주문이 있는 거래처만 남기고, 연체 있는 쪽 → 미수금 큰 쪽 순으로 보여준다.
  return groups
    .filter((group) => group.orders.length > 0)
    .sort((a, b) => {
      const aOverdue = a.orders.some((order) => order.isOverdue);
      const bOverdue = b.orders.some((order) => order.isOverdue);

      if (aOverdue !== bOverdue) {
        return aOverdue ? -1 : 1;
      }

      return b.outstandingBalance - a.outstandingBalance;
    });
}
