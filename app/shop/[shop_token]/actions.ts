"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { BuyerAuthError, requireLinkedBuyer, type LinkedBuyer } from "@/lib/auth/buyer-auth";
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
  /** 카카오 로그인/단골 등록이 필요한 상태 (클라이언트가 게이트를 띄울 수 있도록) */
  requiresAuth?: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildOrderNumber(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.random().toString(36).substring(2, 8).toUpperCase();

  return `ORD-${today}-${suffix}`;
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * 카카오 로그인 직후 자동 생성된 거래처 자리표시자를 발주서 입력값으로 채운다.
 *
 * claim_shop_access() 는 카카오 닉네임만으로 retailers 행을 만들기 때문에
 * 상호/배송지가 비어 있다. 최초 발주 시 한 번만 보완하고, 이미 값이 있으면
 * 건드리지 않는다 (공급사가 정리해 둔 거래처 정보를 덮어쓰지 않기 위해).
 */
async function backfillRetailerProfile(
  supabase: SupabaseServerClient,
  buyer: LinkedBuyer,
  input: { restaurantName: string; contactPhone: string; deliveryAddress: string }
): Promise<void> {
  const retailerPatch: Record<string, string> = {};

  if (!buyer.restaurantName || buyer.restaurantName === "바이어") {
    retailerPatch.restaurant_name = input.restaurantName;
  }

  if (!buyer.deliveryAddress) {
    retailerPatch.delivery_address = input.deliveryAddress;
  }

  if (Object.keys(retailerPatch).length > 0) {
    retailerPatch.updated_at = new Date().toISOString();

    await supabase.from("retailers").update(retailerPatch).eq("id", buyer.retailerId);
  }

  // 카카오는 기본 동의항목에 전화번호가 없어 프로필 연락처가 빈 값으로 생성된다.
  if (!buyer.contactPhone) {
    await supabase
      .from("profiles")
      .update({ phone: input.contactPhone, updated_at: new Date().toISOString() })
      .eq("id", buyer.userId);
  }
}

/**
 * 발주서 최종 제출.
 * 1) 서버 카탈로그로 단가 재해석 → 2) 최소 주문 금액/수량·재고 검증 →
 * 3) auth.uid() 기반 바이어 신원·거래 관계 검증 → 4) orders/order_items 저장 →
 * 5) 공급사 카카오 알림톡 트리거
 *
 * 요청자(바이어) 식별에는 클라이언트 입력을 신뢰하지 않는다. 클라이언트가 보내는 값은
 * shop_token(URL과 동일)·상품ID·수량·배송 정보뿐이고, retailer_id/wholesaler_id 는
 * 항상 서버가 Supabase Auth 세션(auth.uid())에서 도출한다.
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

    if (!UUID_PATTERN.test(input.shopToken ?? "")) {
      return {
        success: false,
        error: "올바른 미니샵 주소가 아닙니다. 공급사에서 받은 알림톡 링크로 다시 접속해주세요.",
      };
    }

    const catalog = await loadShopCatalog(input.shopToken);
    const lines = toCartLines(catalog, input.items ?? []);
    const validation = validateCart(lines);

    if (!validation.ok) {
      return { success: false, error: validation.violations[0].message };
    }

    const totalAmount = validation.totals.totalAmount;
    const orderNumber = buildOrderNumber();
    const supabase = await createClient();

    // Supabase 미설정/데모 카탈로그면 저장을 건너뛰고 알림톡 포맷만 검증한다.
    let buyer: LinkedBuyer | null = null;

    if (!catalog.isDemo) {
      buyer = await requireLinkedBuyer(supabase, input.shopToken);
    }

    // 1) 발주서 저장
    if (buyer) {
      await backfillRetailerProfile(supabase, buyer, {
        restaurantName,
        contactPhone,
        deliveryAddress,
      });

      const { data: insertedOrder, error: orderError } = await supabase
        .from("orders")
        .insert({
          wholesaler_id: buyer.wholesalerId,
          retailer_id: buyer.retailerId,
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
    }

    // 2) 알림톡 품목 요약 ("한우 1++ 등심 2kg 외 1건")
    const [firstLine] = lines;
    const itemsSummary =
      lines.length > 1
        ? `${firstLine.name} ${firstLine.quantity}${firstLine.unit} 외 ${lines.length - 1}건`
        : `${firstLine.name} ${firstLine.quantity}${firstLine.unit}`;

    // 3) 공급사 대표 연락처 조회 후 카카오 알림톡 발송
    let wholesalerPhone: string | undefined;

    if (buyer) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("phone")
        .eq("id", buyer.wholesalerProfileId)
        .maybeSingle();

      wholesalerPhone = (profile?.phone as string | undefined) ?? undefined;
    }

    const notification = await sendOrderNotificationToWholesaler({
      wholesalerName: buyer?.wholesalerName ?? catalog.wholesaler.business_name,
      wholesalerPhone,
      restaurantName,
      orderNumber,
      itemsSummary,
      totalAmount,
      deliveryAddress,
      deliveryNotes,
    });

    if (buyer) {
      revalidatePath("/dashboard/orders");
      revalidatePath(`/shop/${input.shopToken}`);
      revalidatePath(`/shop/${input.shopToken}/orders`);
    }

    return {
      success: true,
      orderNumber,
      totalAmount,
      itemsSummary,
      notificationId: notification.messageId,
      isDemo: !buyer,
    };
  } catch (error: unknown) {
    // 인증/권한 실패는 사용자에게 그대로 보여줄 안내 문구를 담고 있다.
    if (error instanceof BuyerAuthError) {
      return {
        success: false,
        error: error.message,
        requiresAuth: error.code === "auth_required",
      };
    }

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
  /** 카카오 로그인이 필요한 상태 */
  requiresAuth?: boolean;
}

/**
 * 주문 취소 '요청' 접수.
 *
 * 바이어는 요청까지만 생성할 수 있고 최종 취소/반려는 공급사가 대시보드에서 처리한다.
 * 1) 사유·식별자 검증 → 2) auth.uid() 기반 바이어 신원·거래 관계 검증 →
 * 3) 발주서 소유권 확인 → 4) 상태 전이 가능 여부 확인 →
 * 5) status/cancel_reason 저장(영향 행 수 확인) → 6) 공급사 카카오 알림톡 트리거
 *
 * retailer_id/wholesaler_id 는 언제나 Auth 세션에서 도출한다. 링크가 유출되어도
 * 공격자의 카카오 계정으로는 타인의 retailer_id 를 얻을 수 없다.
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

    if (!UUID_PATTERN.test(input.shopToken ?? "")) {
      return {
        success: false,
        error: "올바른 미니샵 주소가 아닙니다. 공급사에서 받은 알림톡 링크로 다시 접속해주세요.",
      };
    }

    if (!UUID_PATTERN.test(input.orderId ?? "")) {
      return { success: false, error: "올바른 발주서 식별자가 아닙니다." };
    }

    const supabase = await createClient();
    const buyer = await requireLinkedBuyer(supabase, input.shopToken);

    // 소유권 검증 — 다른 거래처/다른 공급사의 발주서는 조회 자체가 되지 않아야 한다.
    const { data: order } = await supabase
      .from("orders")
      .select("id, order_number, status, total_amount")
      .eq("id", input.orderId)
      .eq("wholesaler_id", buyer.wholesalerId)
      .eq("retailer_id", buyer.retailerId)
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

    const now = new Date().toISOString();

    // 갱신 조건을 조회 조건과 동일하게 걸고 상태까지 다시 좁힌다.
    // (조회~갱신 사이에 공급사가 출고 처리했다면 0건이 되어야 한다)
    const { data: updated, error: updateError } = await supabase
      .from("orders")
      .update({
        status: "cancel_requested",
        cancel_reason: reason,
        cancel_requested_at: now,
        updated_at: now,
      })
      .eq("id", input.orderId)
      .eq("wholesaler_id", buyer.wholesalerId)
      .eq("retailer_id", buyer.retailerId)
      .in("status", ["pending", "confirmed"])
      .select("id, cancel_requested_at")
      .maybeSingle();

    if (updateError) {
      return {
        success: false,
        error: updateError.message ?? "취소 요청 접수에 실패했습니다. 잠시 후 다시 시도해주세요.",
      };
    }

    // RLS 정책에 걸리거나 상태가 방금 바뀌면 오류 없이 0건으로 끝난다.
    // 알림톡만 나가고 DB는 그대로인 상황을 막기 위해 반드시 영향 행을 확인한다.
    if (!updated) {
      return {
        success: false,
        error:
          "취소 요청을 접수하지 못했습니다. 발주 상태가 방금 변경되었을 수 있으니 주문 내역을 새로고침한 뒤 다시 시도해주세요.",
      };
    }

    const requestedAt = (updated.cancel_requested_at as string | null) ?? now;

    // 공급사 대표 연락처 조회 후 취소 요청 알림톡 발송
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone")
      .eq("id", buyer.wholesalerProfileId)
      .maybeSingle();

    const notification = await sendCancelRequestNotificationToWholesaler({
      wholesalerName: buyer.wholesalerName,
      wholesalerPhone: (profile?.phone as string | undefined) ?? undefined,
      restaurantName: buyer.restaurantName,
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
    if (error instanceof BuyerAuthError) {
      return {
        success: false,
        error: error.message,
        requiresAuth: error.code === "auth_required",
      };
    }

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
