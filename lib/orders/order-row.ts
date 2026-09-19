import type { OrderItem, OrderStatus } from "@/types/database";

/** 주문 목록 화면(테이블/카드) 1행에 필요한 최소 정보 — page.tsx(최초 로드)와
 * actions.ts(기간 변경 재조회) 양쪽에서 같은 모양으로 만들어 쓴다. */
export interface OrderRow {
  id: string;
  orderNumber: string;
  retailerName: string;
  status: OrderStatus;
  totalAmount: number;
  itemCount: number;
  itemSummary: string;
  orderedAt: string;
  deliveryAddress: string;
}

/** orders + order_items + retailers 조인 응답 형태 */
export interface OrderJoinRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  total_amount: number;
  delivery_address: string;
  ordered_at: string;
  order_items: Pick<OrderItem, "product_name" | "quantity">[] | null;
  retailers: { restaurant_name: string } | { restaurant_name: string }[] | null;
}

export const ORDER_LIST_SELECT_COLUMNS =
  "id, order_number, status, total_amount, delivery_address, ordered_at, order_items ( product_name, quantity ), retailers ( restaurant_name )";

/**
 * 거래처 상호(retailers.restaurant_name)로 필터링할 때 쓴다. PostgREST는 embedded
 * 리소스 컬럼을 필터 조건으로 쓰려면 그 리소스가 inner join이어야 해서 별도로 둔다.
 * (select 문자열을 런타임에 조합하면 Supabase 타입 추론이 깨지므로 리터럴로 유지)
 */
export const ORDER_LIST_SELECT_COLUMNS_RETAILER_INNER =
  "id, order_number, status, total_amount, delivery_address, ordered_at, order_items ( product_name, quantity ), retailers!inner ( restaurant_name )";

function retailerName(row: OrderJoinRow): string {
  const retailer = Array.isArray(row.retailers) ? row.retailers[0] : row.retailers;

  return retailer?.restaurant_name ?? "이름 미등록 고객(소매)";
}

/** "한우 1++ 등심 2 외 2건" 형태의 품목 요약 */
export function summarizeItems(items: Pick<OrderItem, "product_name" | "quantity">[]): string {
  if (items.length === 0) {
    return "품목 정보 없음";
  }

  const [first] = items;
  const head = `${first.product_name} ${Number(first.quantity)}`;

  return items.length > 1 ? `${head} 외 ${items.length - 1}건` : head;
}

export function mapOrderJoinRow(row: OrderJoinRow): OrderRow {
  const items = row.order_items ?? [];

  return {
    id: row.id,
    orderNumber: row.order_number,
    retailerName: retailerName(row),
    status: row.status,
    totalAmount: Number(row.total_amount),
    itemCount: items.length,
    itemSummary: summarizeItems(items),
    orderedAt: row.ordered_at,
    deliveryAddress: row.delivery_address,
  };
}
