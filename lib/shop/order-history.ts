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
import { ORDER_HISTORY_PAGE_SIZE } from "@/lib/orders/history-range";
import type { OrderStatus } from "@/types/database";

const EMPTY_HISTORY: ShopOrderHistory = {
  orders: [],
  notice: null,
  requiresLink: false,
  totalCount: 0,
  hasMore: false,
};

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

export interface LoadShopOrderHistoryOptions {
  /** null이면 전체 기간. 생략 시 기본 구간(DEFAULT_ORDER_HISTORY_DAYS)을 호출부가 넘긴다. */
  rangeDays?: number | null;
  offset?: number;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

interface FetchOrderPageResult {
  orders: ShopOrder[];
  totalCount: number;
  hasMore: boolean;
  /** 조회 자체가 실패한 경우에만 채워진다 — "0건"과 "조회 실패"를 구분하는 용도. */
  error: string | null;
}

/** null(전체 기간) 또는 유효한 양의 정수만 허용 — 그 외(NaN, 음수 등)는 전체 기간으로 취급한다. */
function sanitizeRangeDays(rangeDays: number | null): number | null {
  if (rangeDays === null) return null;

  return Number.isFinite(rangeDays) && rangeDays > 0 ? Math.floor(rangeDays) : null;
}

/**
 * 조회 구간/더보기 페이지 단위로 발주 목록 + 품목을 가져온다.
 * 최초 로드(loadShopOrderHistory)와 "구간 변경/더보기" 클라이언트 액션
 * (app/shop/[shop_token]/actions.ts의 loadShopOrderHistoryPageAction)이 공용으로 쓴다.
 */
export async function fetchShopOrderPage(
  supabase: SupabaseServerClient,
  wholesalerId: string,
  retailerId: string,
  { rangeDays = null, offset = 0 }: LoadShopOrderHistoryOptions = {}
): Promise<FetchOrderPageResult> {
  const safeRangeDays = sanitizeRangeDays(rangeDays);

  let query = supabase
    .from("orders")
    .select(
      "id, order_number, status, total_amount, delivery_address, delivery_notes, ordered_at, cancel_reason, cancel_requested_at, cancel_resolved_at, courier_code, tracking_number",
      { count: "exact" }
    )
    .eq("wholesaler_id", wholesalerId)
    .eq("retailer_id", retailerId);

  if (safeRangeDays !== null) {
    const cutoff = new Date(Date.now() - safeRangeDays * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("ordered_at", cutoff);
  }

  const { data: orderRows, count, error } = await query
    .order("ordered_at", { ascending: false })
    .range(offset, offset + ORDER_HISTORY_PAGE_SIZE - 1);

  if (error) {
    console.error("[Shop Order History ERROR]", error);
    return {
      orders: [],
      totalCount: 0,
      hasMore: false,
      error: "주문 내역을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
    };
  }

  const rows = (orderRows ?? []) as OrderRow[];
  const totalCount = count ?? 0;

  if (rows.length === 0) {
    return { orders: [], totalCount, hasMore: false, error: null };
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
      category: item.category,
      productName: item.product_name,
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

  return { orders, totalCount, hasMore: offset + orders.length < totalCount, error: null };
}

/**
 * 접속 고객의 주문 내역 조회(최초 페이지 로드용).
 * 고객 식별은 항상 서버(카탈로그 로더)가 해석한 값만 사용한다.
 *
 * 오래 거래한 단골일수록 발주 건수가 무한정 쌓일 수 있어(예전엔 최근 30건 고정 상한) 공급사
 * 쪽 발주 관리(app/dashboard/orders)와 동일하게 조회 구간(30일/3개월/전체)과
 * ORDER_HISTORY_PAGE_SIZE 단위 더보기로 바꾼다.
 */
export async function loadShopOrderHistory(
  catalog: ShopCatalog,
  options: LoadShopOrderHistoryOptions = {}
): Promise<ShopOrderHistory> {
  if (!catalog.customer.retailerId) {
    return {
      ...EMPTY_HISTORY,
      notice: "주문 내역은 공급사에서 받은 초대 링크로 단골 인증을 완료한 뒤 확인할 수 있습니다.",
      requiresLink: true,
    };
  }

  const supabase = await createClient();
  const { orders, totalCount, hasMore, error } = await fetchShopOrderPage(
    supabase,
    catalog.wholesaler.id,
    catalog.customer.retailerId,
    options
  );

  if (error) {
    return { ...EMPTY_HISTORY, notice: error };
  }

  if (orders.length === 0) {
    const { rangeDays = null } = options;

    return {
      ...EMPTY_HISTORY,
      // 구간이 지정된 상태에서 0건이면 "그 구간엔 없다"는 뜻이라 다른 구간을 안내하고,
      // 전체 기간(rangeDays=null)까지 0건이면 애초에 발주 이력이 없는 것이다.
      notice:
        rangeDays !== null
          ? `최근 ${rangeDays}일간 발주 내역이 없습니다. 다른 기간을 선택해보세요.`
          : "아직 접수된 발주서가 없습니다.",
      totalCount,
    };
  }

  return { orders, notice: null, requiresLink: false, totalCount, hasMore };
}
