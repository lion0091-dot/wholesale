"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  sendCancelRequestNotificationToWholesaler,
  sendOrderNotificationToWholesaler,
} from "@/lib/notifications/alimtalk";
import { canRequestCancel } from "@/lib/orders/status";
import { loadShopCatalog, toCartLines, type CartEntryInput } from "@/lib/shop/catalog";
import { validateCancelReason } from "@/lib/shop/order-history-types";
import { lineSubtotal, validateCart } from "@/lib/shop/order-policy";
import type { OrderStatus } from "@/types/database";

export interface SubmitOrderInput {
  shopToken: string;
  /** 상품ID + 수량만 전달받고 단가/금액은 서버 카탈로그에서 재계산한다. */
  items: CartEntryInput[];
  restaurantName: string;
  contactPhone: string;
  deliveryAddress: string;
  deliveryNotes?: string;
}

export interface SubmitOrderResult {
  success: boolean;
  error?: string;
  orderNumber?: string;
  totalAmount?: number;
  itemsSummary?: string;
  notificationId?: string;
  /** DB 저장 없이 알림톡 포맷만 검증한 시연 모드 여부 */
  isDemo?: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildOrderNumber(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();

  return `ORD-${today}-${suffix}`;
}

/**
 * 발주서 최종 제출.
 * 1) 서버 카탈로그로 단가 재해석 → 2) 최소 주문 금액/수량·재고 검증 →
 * 3) orders/order_items 저장 → 4) 공급사 카카오 알림톡 트리거
 */
export async function submitOrderAction(input: SubmitOrderInput): Promise<SubmitOrderResult> {
  try {
    const restaurantName = input.restaurantName?.trim() ?? "";
    const contactPhone = input.contactPhone?.trim() ?? "";
    const deliveryAddress = input.deliveryAddress?.trim() ?? "";
    const deliveryNotes = input.deliveryNotes?.trim() || null;

    if (!restaurantName || !contactPhone || !deliveryAddress) {
      return {
        success: false,
        error: "사업장(상호)명, 담당자 연락처, 배송지 주소는 필수 입력 사항입니다.",
      };
    }

    const catalog = await loadShopCatalog(input.shopToken);
    const lines = toCartLines(catalog, input.items ?? []);
    const validation = validateCart(lines);

    if (!validation.ok) {
      return { success: false, error: validation.violations[0].message };
    }

    if (!catalog.isDemo && !catalog.customer.retailerId) {
      return {
        success: false,
        error: "초대 링크로 확인된 거래처만 발주할 수 있습니다. 공급사에서 받은 링크로 다시 접속해주세요.",
      };
    }

    const totalAmount = validation.totals.totalAmount;
    const orderNumber = buildOrderNumber();
    const supabase = await createClient();

    // 1) 발주서 저장 (Supabase 미설정/데모 카탈로그면 저장을 건너뛰고 알림톡 포맷만 검증)
    let savedToDb = false;

    if (!catalog.isDemo && catalog.customer.retailerId) {
      const { data: insertedOrder, error: orderError } = await supabase
        .from("orders")
        .insert({
          wholesaler_id: catalog.wholesaler.id,
          retailer_id: catalog.customer.retailerId,
          order_number: orderNumber,
          total_amount: totalAmount,
          status: "pending",
          delivery_address: deliveryAddress,
          delivery_notes: deliveryNotes,
        })
        .select("id")
        .single();

      if (orderError || !insertedOrder) {
        return {
          success: false,
          error: orderError?.message ?? "발주서 저장에 실패했습니다. 잠시 후 다시 시도해주세요.",
        };
      }

      const { error: itemsError } = await supabase.from("order_items").insert(
        lines.map((line) => ({
          order_id: insertedOrder.id as string,
          product_id: line.productId,
          product_name: line.name,
          unit_price: line.unitPrice,
          quantity: line.quantity,
          subtotal_amount: lineSubtotal(line),
        }))
      );

      if (itemsError) {
        // 품목 없는 빈 발주서가 남지 않도록 헤더를 롤백한다.
        await supabase.from("orders").delete().eq("id", insertedOrder.id as string);

        return { success: false, error: "발주 품목 저장에 실패했습니다. 다시 시도해주세요." };
      }

      savedToDb = true;
    }

    // 2) 알림톡 품목 요약 ("한우 1++ 등심 2kg 외 1건")
    const [firstLine] = lines;
    const itemsSummary =
      lines.length > 1
        ? `${firstLine.name} ${firstLine.quantity}${firstLine.unit} 외 ${lines.length - 1}건`
        : `${firstLine.name} ${firstLine.quantity}${firstLine.unit}`;

    // 3) 공급사 대표 연락처 조회 후 카카오 알림톡 발송
    let wholesalerPhone: string | undefined;

    if (savedToDb) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("phone")
        .eq("id", catalog.wholesaler.profile_id)
        .maybeSingle();

      wholesalerPhone = (profile?.phone as string | undefined) ?? undefined;
    }

    const notification = await sendOrderNotificationToWholesaler({
      wholesalerName: catalog.wholesaler.business_name,
      wholesalerPhone,
      restaurantName,
      orderNumber,
      itemsSummary,
      totalAmount,
      deliveryAddress,
      deliveryNotes,
    });

    if (savedToDb) {
      revalidatePath("/dashboard/orders");
      revalidatePath(`/shop/${input.shopToken}`);
    }

    return {
      success: true,
      orderNumber,
      totalAmount,
      itemsSummary,
      notificationId: notification.messageId,
      isDemo: !savedToDb,
    };
  } catch (error: unknown) {
    console.error("[Shop Order ERROR]", error);

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "주문 처리 중 알 수 없는 오류가 발생했습니다.",
    };
  }
}

// ====================================================================
// 주문 취소 요청 (바이어 → 공급사)
// ====================================================================

export interface RequestOrderCancelInput {
  shopToken: string;
  orderId: string;
  /** 바이어가 입력한 취소 사유 */
  reason: string;
}

export interface RequestOrderCancelResult {
  success: boolean;
  error?: string;
  /** 요청 접수 후 주문 상태 */
  status?: OrderStatus;
  /** 접수 시각 (ISO) */
  requestedAt?: string;
  notificationId?: string;
}

/**
 * 주문 취소 '요청' 접수.
 *
 * 바이어는 요청까지만 생성할 수 있고 최종 취소/반려는 공급사가 대시보드에서 처리한다.
 * 1) 사유 검증 → 2) 서버 세션으로 주문 소유권 확인 → 3) 상태 전이 가능 여부 확인 →
 * 4) status/cancel_reason 저장 → 5) 공급사 카카오 알림톡 트리거
 *
 * 주문 식별자만 있으면 되고, 요청자(바이어) 식별은 클라이언트 입력을 신뢰하지 않고
 * 항상 서버 카탈로그 로더가 해석한 고객 세션을 사용한다.
 */
export async function requestOrderCancelAction(
  input: RequestOrderCancelInput
): Promise<RequestOrderCancelResult> {
  try {
    const reason = input.reason?.trim() ?? "";
    const reasonError = validateCancelReason(reason);

    if (reasonError) {
      return { success: false, error: reasonError };
    }

    if (!UUID_PATTERN.test(input.orderId ?? "")) {
      return { success: false, error: "올바른 발주서 식별자가 아닙니다." };
    }

    const catalog = await loadShopCatalog(input.shopToken);

    if (catalog.isDemo || !catalog.customer.retailerId) {
      return {
        success: false,
        error: "초대 링크로 확인된 거래처만 취소를 요청할 수 있습니다. 공급사에서 받은 링크로 다시 접속해주세요.",
      };
    }

    const supabase = await createClient();

    // 소유권 검증 — 다른 거래처/다른 공급사의 발주서는 조회 자체가 되지 않아야 한다.
    const { data: order } = await supabase
      .from("orders")
      .select("id, order_number, status, total_amount")
      .eq("id", input.orderId)
      .eq("wholesaler_id", catalog.wholesaler.id)
      .eq("retailer_id", catalog.customer.retailerId)
      .maybeSingle();

    if (!order) {
      return { success: false, error: "해당 발주서를 찾을 수 없습니다." };
    }

    const currentStatus = order.status as OrderStatus;

    if (currentStatus === "cancel_requested") {
      return { success: false, error: "이미 취소 요청이 접수된 발주서입니다. 공급사 확인을 기다려주세요." };
    }

    if (!canRequestCancel(currentStatus)) {
      return {
        success: false,
        error: "이미 출고가 진행된 발주서는 직접 취소할 수 없습니다. 공급사에 유선으로 문의해주세요.",
      };
    }

    const requestedAt = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        status: "cancel_requested",
        cancel_reason: reason,
        cancel_requested_at: requestedAt,
        updated_at: requestedAt,
      })
      .eq("id", input.orderId)
      .eq("retailer_id", catalog.customer.retailerId);

    if (updateError) {
      return {
        success: false,
        error: updateError.message ?? "취소 요청 접수에 실패했습니다. 잠시 후 다시 시도해주세요.",
      };
    }

    // 공급사 대표 연락처 조회 후 취소 요청 알림톡 발송
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone")
      .eq("id", catalog.wholesaler.profile_id)
      .maybeSingle();

    const notification = await sendCancelRequestNotificationToWholesaler({
      wholesalerName: catalog.wholesaler.business_name,
      wholesalerPhone: (profile?.phone as string | undefined) ?? undefined,
      restaurantName: catalog.customer.restaurantName ?? "바이어",
      orderNumber: order.order_number as string,
      totalAmount: Number(order.total_amount),
      cancelReason: reason,
    });

    revalidatePath(`/shop/${input.shopToken}/orders`);
    revalidatePath("/dashboard/orders");
    revalidatePath(`/dashboard/orders/${input.orderId}`);

    return {
      success: true,
      status: "cancel_requested",
      requestedAt,
      notificationId: notification.messageId,
    };
  } catch (error: unknown) {
    console.error("[Shop Cancel Request ERROR]", error);

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "취소 요청 처리 중 알 수 없는 오류가 발생했습니다.",
    };
  }
}
