/**
 * 미니샵 주문 내역 로더.
 *
 * /shop/<shop_token>/orders 가 사용한다.
 * - 접속 고객(바이어)이 해당 공급사에 넣은 발주서만 조회 (교차 조회 차단)
 * - 발주 품목은 order_items에 적재된 '발주 시점 단가'를 그대로 노출한다
 *   (카탈로그 단가가 이후에 바뀌어도 주문 내역은 변하지 않아야 한다)
 *
 * 서버 전용 모듈(next/headers 의존). 클라이언트 컴포넌트는 타입·순수 함수만 있는
 * `@/lib/shop/order-history-types`를 import 해야 한다.
 */

import { createClient } from "@/lib/supabase/server";
import type { ShopCatalog } from "@/lib/shop/catalog-types";
import type {
  ShopOrder,
  ShopOrderHistory,
  ShopOrderLine,
} from "@/lib/shop/order-history-types";
import type { OrderStatus } from "@/types/database";
import { composeProductDisplayName } from "@/lib/products/display-name";

/** 미니샵에 노출할 최근 발주 건수 */
const ORDER_HISTORY_LIMIT = 30;

const EMPTY_HISTORY: ShopOrderHistory = { orders: [], notice: null, requiresLink: false };

export type {
  ShopOrder,
  ShopOrderHistory,
  ShopOrderLine,
} from "@/lib/shop/order-history-types";

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  total_amount: number | string;
  delivery_address: string | null;
  delivery_notes: string | null;
  ordered_at: string;
  cancel_reason: string | null;
  cancel_requested_at: string | null;
  cancel_resolved_at: string | null;
  courier_code: string | null;
  tracking_number: string | null;
};

type OrderItemRow = {
  id: string;
  order_id: string;
  product_name: string;
  category: string | null;
  unit_price: number | string;
  quantity: number | string;
  subtotal_amount: number | string;
};

/**
 * 접속 고객의 주문 내역 조회.
 * 고객 식별은 항상 서버(카탈로그 로더)가 해석한 값만 사용한다.
 */
export async function loadShopOrderHistory(catalog: ShopCatalog): Promise<ShopOrderHistory> {
  if (!catalog.customer.retailerId) {
    return {
      ...EMPTY_HISTORY,
      notice: "주문 내역은 공급사에서 받은 초대 링크로 단골 인증을 완료한 뒤 확인할 수 있습니다.",
      requiresLink: true,
    };
  }

  if (catalog.isDemo) {
    return {
      ...EMPTY_HISTORY,
      notice: "시연(데모) 카탈로그에서는 주문 내역이 조회되지 않습니다. 실제 공급사 링크로 접속해주세요.",
    };
  }

  const supabase = await createClient();

  const { data: orderRows, error } = await supabase
    .from("orders")
    .select(
      "id, order_number, status, total_amount, delivery_address, delivery_notes, ordered_at, cancel_reason, cancel_requested_at, cancel_resolved_at, courier_code, tracking_number"
    )
    .eq("wholesaler_id", catalog.wholesaler.id)
    .eq("retailer_id", catalog.customer.retailerId)
    .order("ordered_at", { ascending: false })
    .limit(ORDER_HISTORY_LIMIT);

  if (error) {
    console.error("[Shop Order History ERROR]", error);

    return {
      ...EMPTY_HISTORY,
      notice: "주문 내역을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
    };
  }

  const rows = (orderRows ?? []) as OrderRow[];

  if (rows.length === 0) {
    return { ...EMPTY_HISTORY, notice: "아직 접수된 발주서가 없습니다." };
  }

  const { data: itemRows } = await supabase
    .from("order_items")
    .select("id, order_id, product_name, category, unit_price, quantity, subtotal_amount")
    .in(
      "order_id",
      rows.map((row) => row.id)
    );

  const linesByOrder = new Map<string, ShopOrderLine[]>();

  for (const item of (itemRows ?? []) as OrderItemRow[]) {
    const lines = linesByOrder.get(item.order_id) ?? [];

    lines.push({
      id: item.id,
      productName: composeProductDisplayName(item.category, item.product_name),
      unitPrice: Number(item.unit_price),
      quantity: Number(item.quantity),
      subtotalAmount: Number(item.subtotal_amount),
    });

    linesByOrder.set(item.order_id, lines);
  }

  const orders: ShopOrder[] = rows.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    status: row.status as OrderStatus,
    totalAmount: Number(row.total_amount),
    deliveryAddress: row.delivery_address ?? "",
    deliveryNotes: row.delivery_notes,
    orderedAt: row.ordered_at,
    cancelReason: row.cancel_reason,
    cancelRequestedAt: row.cancel_requested_at,
    cancelResolvedAt: row.cancel_resolved_at,
    courierCode: row.courier_code,
    trackingNumber: row.tracking_number,
    lines: linesByOrder.get(row.id) ?? [],
  }));

  return { orders, notice: null, requiresLink: false };
}
