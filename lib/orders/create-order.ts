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

export type CreateOrderResult = { orderId: string } | { error: string };

/**
 * 핫딜 한도 초과 시 reserve_hot_deal_quota RPC가 던지는 예외
 * 'HOT_DEAL_QUOTA_EXCEEDED:<상품명>:<한도>:<이미판매>:<이번주문수량>'.
 */
// 상품명에 콜론이 섞여도(예: 등급 표기 복사-붙여넣기) 뒤의 숫자 3개가 우선 매치되도록
// name을 lazy가 아닌 greedy로 잡는다 — INSUFFICIENT_STOCK_PATTERN도 같은 문제가 있음.
const HOT_DEAL_QUOTA_EXCEEDED_PATTERN = /HOT_DEAL_QUOTA_EXCEEDED:(.+):([\d.]+):([\d.]+):([\d.]+)/;

function translateHotDealQuotaError(message: string): string | null {
  const matched = message.match(HOT_DEAL_QUOTA_EXCEEDED_PATTERN);

  if (!matched) {
    return null;
  }

  const [, productName] = matched;

  return `${productName} 핫딜 매진 — 방금 다른 주문이 먼저 가져갔습니다. 일반 단가로 다시 담아 발주해주세요.`;
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
    return { error: orderError?.message ?? "발주서 저장에 실패했습니다. 잠시 후 다시 시도해주세요." };
  }

  const orderId = insertedOrder.id as string;

  const { error: itemsError } = await supabase.from("order_items").insert(
    params.lines.map((line) => ({
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
    // 품목 없는 빈 발주서가 남지 않도록 헤더를 롤백한다.
    await supabase.from("orders").delete().eq("id", orderId);
    return { error: "발주 품목 저장에 실패했습니다. 다시 시도해주세요." };
  }

  // 핫딜 한도는 "결제(발주 생성)" 순간에 소비된다(확정 시점이 아님) — 손님들이 실시간으로
  // 경쟁 구매하는 상황이라 여기서 막아야 의미가 있다. 상품 행을 잠그고 순서대로
  // 처리하므로 두 손님이 동시에 눌러도 한도를 넘기는 일 자체가 안 생긴다.
  const { error: quotaError } = await supabase.rpc("reserve_hot_deal_quota", { p_order_id: orderId });

  if (quotaError) {
    await supabase.from("orders").delete().eq("id", orderId);
    return {
      error:
        translateHotDealQuotaError(quotaError.message) ??
        "핫딜 한도 확인 중 오류가 발생했습니다. 다시 시도해주세요.",
    };
  }

  return { orderId };
}
