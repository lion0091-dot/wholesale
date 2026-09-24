/**
 * 주문(orders + order_items) 저장 — submitOrderAction(직접정산/외상)과 PG 결제
 * 승인 성공 콜백(app/shop/[shop_token]/checkout/pg/success/route.ts) 양쪽이 공유한다.
 *
 * PG 결제는 "결제 확정 후에만 주문 생성"(pg_pending_payments 참고) 원칙이라 이 함수가
 * 두 경로에서 똑같이 호출돼야 알림톡 발송 시점/주문 생성 로직이 어긋나지 않는다.
 */

import type { createClient } from "@/lib/supabase/server";
import type { CartLine } from "@/lib/shop/order-policy";
import { lineSubtotal } from "@/lib/shop/order-policy";
import type { PaymentMethod, PaymentStatus } from "@/types/database";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export interface CreateOrderParams {
  wholesalerId: string;
  retailerId: string;
  orderNumber: string;
  totalAmount: number;
  deliveryAddress: string;
  deliveryNotes: string | null;
  paymentMethod: PaymentMethod;
  lines: CartLine[];
  /** 고객이 주문할 때 남긴 가격 관련 요청. 네고를 안 쓰면 undefined/null로 둔다. */
  negotiationNote?: string | null;
  /** PG 결제만 채운다 — 직접정산/외상은 undefined로 두면 컬럼이 NULL로 남는다. */
  paymentStatus?: PaymentStatus;
  pgPaymentKey?: string;
  pgOrderId?: string;
}

/**
 * 실패 사유 분류 — PG 경로는 사유에 따라 후속 처리가 다르다(핫딜 매진이면 자동 환불,
 * 같은 결제로 이미 주문이 있으면 멱등 처리). 직접정산/외상 경로는 문구만 쓴다.
 */
export type CreateOrderErrorCode = "HOT_DEAL_QUOTA_EXCEEDED" | "DUPLICATE_PG_ORDER" | "UNKNOWN";

export type CreateOrderResult = { orderId: string } | { error: string; code: CreateOrderErrorCode };

/** orders(pg_order_id) 부분 유니크 인덱스 이름(20260930000101). 위반 메시지에 그대로 실려 온다. */
export const PG_ORDER_UNIQUE_INDEX = "idx_orders_pg_order_id_unique";

/** DB 오류 문자열에서 후속 처리에 필요한 사유만 골라낸다. */
export function classifyCreateOrderError(message: string): CreateOrderErrorCode {
  if (message.includes(PG_ORDER_UNIQUE_INDEX)) {
    return "DUPLICATE_PG_ORDER";
  }

  if (HOT_DEAL_QUOTA_EXCEEDED_PATTERN.test(message)) {
    return "HOT_DEAL_QUOTA_EXCEEDED";
  }

  return "UNKNOWN";
}

/**
 * 핫딜 한도 초과 시 reserve_hot_deal_quota RPC가 던지는 예외
 * 'HOT_DEAL_QUOTA_EXCEEDED:<상품명>:<한도>:<이미판매>:<이번주문수량>'.
 */
// 상품명에 콜론이 섞여도(예: 등급 표기 복사-붙여넣기) 뒤의 숫자 3개가 우선 매치되도록
// name을 lazy가 아닌 greedy로 잡는다 — INSUFFICIENT_STOCK_PATTERN도 같은 문제가 있음.
const HOT_DEAL_QUOTA_EXCEEDED_PATTERN = /HOT_DEAL_QUOTA_EXCEEDED:(.+):([\d.]+):([\d.]+):([\d.]+)/;

export function translateHotDealQuotaError(message: string): string | null {
  const matched = message.match(HOT_DEAL_QUOTA_EXCEEDED_PATTERN);

  if (!matched) {
    return null;
  }

  const [, productName] = matched;

  return `${productName} 핫딜 매진 — 방금 다른 주문이 먼저 가져갔습니다. 일반 단가로 다시 담아 발주해주세요.`;
}

/**
 * 저장 도중 실패한 접수대기 주문을 지운다. orders에는 DELETE 정책이 없어 바이어 세션의
 * `.delete()`는 0행으로 조용히 끝나므로(실패한 주문이 접수대기로 남던 버그), 소유자·접수대기
 * 조건을 서버에서 확인하고 소진된 핫딜 한도까지 돌려주는 RPC(20260930000103)로 지운다.
 * 정리 자체의 실패는 호출자에게 알릴 방법이 없으니 로그만 남긴다.
 */
export async function discardUnfulfilledOrder(supabase: SupabaseServerClient, orderId: string): Promise<void> {
  const { error } = await supabase.rpc("discard_unfulfilled_order", { p_order_id: orderId });

  if (error) {
    console.error("[createOrder] 실패한 주문 정리 실패:", orderId, error.message);
  }
}

export function buildOrderNumber(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();

  return `ORD-${today}-${suffix}`;
}

export async function createOrderWithItems(
  supabase: SupabaseServerClient,
  params: CreateOrderParams
): Promise<CreateOrderResult> {
  const { data: insertedOrder, error: orderError } = await supabase
    .from("orders")
    .insert({
      wholesaler_id: params.wholesalerId,
      retailer_id: params.retailerId,
      order_number: params.orderNumber,
      total_amount: params.totalAmount,
      status: "pending",
      payment_method: params.paymentMethod,
      payment_status: params.paymentStatus ?? null,
      pg_payment_key: params.pgPaymentKey ?? null,
      pg_order_id: params.pgOrderId ?? null,
      delivery_address: params.deliveryAddress,
      delivery_notes: params.deliveryNotes,
      negotiation_note: params.negotiationNote ?? null,
    })
    .select("id")
    .single();

  if (orderError || !insertedOrder) {
    const message = orderError?.message ?? "";

    return {
      error: message || "발주서 저장에 실패했습니다. 잠시 후 다시 시도해주세요.",
      code: classifyCreateOrderError(message),
    };
  }

  const orderId = insertedOrder.id as string;

  // 품목 INSERT 트리거(20260930000103)가 핫딜 줄마다 상품 행을 잠근다 — 두 손님이 같은
  // 상품들을 서로 다른 순서로 담으면 데드락이 날 수 있으니 상품 ID 순으로 고정해 넣는다
  // (reserve_hot_deal_quota의 ORDER BY product_id와 같은 이유).
  const orderedLines = [...params.lines].sort((a, b) => a.productId.localeCompare(b.productId));

  const { error: itemsError } = await supabase.from("order_items").insert(
    orderedLines.map((line) => ({
      order_id: orderId,
      product_id: line.productId,
      product_name: line.name,
      category: line.category,
      subcategory: line.subcategory,
      unit_price: line.unitPrice,
      quantity: line.quantity,
      subtotal_amount: lineSubtotal(line),
      requested_unit_price: line.requestedUnitPrice ?? null,
      // 이 발주가 핫딜가로 팔린 줄인지 스냅샷 — hot_deal_active가 나중에 바뀌어도
      // 이 주문이 핫딜 소비였는지는 변하지 않아야 한도 반환(취소 시)이 정확하다.
      is_hot_deal: line.isHotDeal,
    }))
  );

  if (itemsError) {
    // 품목 없는 빈 발주서가 남지 않도록 헤더를 지운다.
    await discardUnfulfilledOrder(supabase, orderId);
    // 바이어 경로에서는 품목 트리거가 핫딜 한도를 이 자리에서 소진하므로 매진 오류가
    // 여기서 먼저 나온다 — 아래 reserve 단계와 같은 분류·문구로 돌려준다.
    return {
      error:
        translateHotDealQuotaError(itemsError.message) ?? "발주 품목 저장에 실패했습니다. 다시 시도해주세요.",
      code: classifyCreateOrderError(itemsError.message),
    };
  }

  // 핫딜 한도는 "결제(발주 생성)" 순간에 소비된다(확정 시점이 아님) — 손님들이 실시간으로
  // 경쟁 구매하는 상황이라 여기서 막아야 의미가 있다. 상품 행을 잠그고 순서대로
  // 처리하므로 두 손님이 동시에 눌러도 한도를 넘기는 일 자체가 안 생긴다.
  // 바이어 세션은 위 품목 트리거가 이미 소진·예약해 두므로 이 호출은 no-op이고,
  // 재대조 크론(service_role) 경로에서만 실제로 소진한다.
  const { error: quotaError } = await supabase.rpc("reserve_hot_deal_quota", { p_order_id: orderId });

  if (quotaError) {
    await discardUnfulfilledOrder(supabase, orderId);
    return {
      error:
        translateHotDealQuotaError(quotaError.message) ??
        "핫딜 한도 확인 중 오류가 발생했습니다. 다시 시도해주세요.",
      code: classifyCreateOrderError(quotaError.message),
    };
  }

  return { orderId };
}
