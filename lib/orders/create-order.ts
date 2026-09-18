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
  /** PG 결제만 채운다 — 직접정산/외상은 undefined로 두면 컬럼이 NULL로 남는다. */
  paymentStatus?: PaymentStatus;
  pgPaymentKey?: string;
  pgOrderId?: string;
}

export type CreateOrderResult = { orderId: string } | { error: string };

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
    }))
  );

  if (itemsError) {
    // 품목 없는 빈 발주서가 남지 않도록 헤더를 롤백한다.
    await supabase.from("orders").delete().eq("id", orderId);
    return { error: "발주 품목 저장에 실패했습니다. 다시 시도해주세요." };
  }

  return { orderId };
}
