"use server";

import { createClient } from "@/lib/supabase/server";
import { sendOrderNotificationToWholesaler } from "@/lib/notifications/alimtalk";
import type { Order, OrderItem } from "@/types/database";

export interface CreateOrderInput {
  shopToken: string;
  wholesalerId: string;
  wholesalerName: string;
  wholesalerPhone?: string;
  restaurantName: string;
  contactPhone: string;
  deliveryAddress: string;
  deliveryNotes?: string;
  items: Array<{
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    unit: string;
    subtotalAmount: number;
  }>;
  totalAmount: number;
}

export interface CreateOrderResult {
  success: boolean;
  orderNumber?: string;
  message?: string;
  error?: string;
  notificationId?: string;
}

export async function createOrderAction(input: CreateOrderInput): Promise<CreateOrderResult> {
  try {
    if (!input.items || input.items.length === 0) {
      return { success: false, error: "장바구니에 담긴 품목이 없습니다." };
    }

    if (!input.restaurantName || !input.deliveryAddress) {
      return { success: false, error: "사업장(상호)명과 배송지 주소는 필수 입력 사항입니다." };
    }

    // 1. 고유 주문번호 생성 (ORD-YYYYMMDD-XXXXXX)
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const randomHex = Math.random().toString(36).substring(2, 8).toUpperCase();
    const orderNumber = `ORD-${todayStr}-${randomHex}`;

    const supabase = await createClient();

    // 2. 현재 로그인 사용자 및 식당(retailer) 정보 조회
    const { data: { user } } = await supabase.auth.getUser();
    let retailerId = "demo-retailer-id";

    if (user) {
      const { data: retailer } = await supabase
        .from("retailers")
        .select("id")
        .eq("profile_id", user.id)
        .single();
      if (retailer) {
        retailerId = retailer.id;
      }
    }

    // 3. Supabase DB 저장 시도 (실제 DB 연결 시)
    let orderSavedToDb = false;
    let createdOrderId = "";

    try {
      const { data: insertedOrder, error: orderError } = await supabase
        .from("orders")
        .insert({
          wholesaler_id: input.wholesalerId,
          retailer_id: retailerId,
          order_number: orderNumber,
          total_amount: input.totalAmount,
          status: "pending",
          delivery_address: input.deliveryAddress,
          delivery_notes: input.deliveryNotes || null,
        })
        .select("id")
        .single();

      if (!orderError && insertedOrder) {
        orderSavedToDb = true;
        createdOrderId = insertedOrder.id;

        const orderItemsPayload = input.items.map((item) => ({
          order_id: createdOrderId,
          product_id: item.productId,
          product_name: item.productName,
          unit_price: item.unitPrice,
          quantity: item.quantity,
          subtotal_amount: item.subtotalAmount,
        }));

        await supabase.from("order_items").insert(orderItemsPayload);
      }
    } catch (dbErr) {
      console.warn("[Order Action] DB 저장 Fallback (데모 모드 동작):", dbErr);
    }

    // 4. 품목 요약 문구 생성 (예: "한우 1++ 등심 2kg 외 1건")
    const firstItem = input.items[0];
    const itemsSummary = input.items.length > 1
      ? `${firstItem.productName} ${firstItem.quantity}${firstItem.unit} 외 ${input.items.length - 1}건`
      : `${firstItem.productName} ${firstItem.quantity}${firstItem.unit}`;

    // 5. 카카오 알림톡 발송 트리거 호출
    const notification = await sendOrderNotificationToWholesaler({
      wholesalerName: input.wholesalerName,
      wholesalerPhone: input.wholesalerPhone,
      restaurantName: input.restaurantName,
      orderNumber,
      itemsSummary,
      totalAmount: input.totalAmount,
      deliveryAddress: input.deliveryAddress,
      deliveryNotes: input.deliveryNotes,
    });

    return {
      success: true,
      orderNumber,
      notificationId: notification.messageId,
      message: "발주서가 성공적으로 전송되었으며 도매처에 알림톡이 발송되었습니다.",
    };
  } catch (error: unknown) {
    console.error("[Order Action ERROR]", error);
    const errorMessage = error instanceof Error ? error.message : "주문 처리 중 알 수 없는 오류가 발생했습니다.";
    return { success: false, error: errorMessage };
  }
}
