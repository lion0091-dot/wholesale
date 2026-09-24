"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { BuyerAuthError, requireLinkedBuyer, type LinkedBuyer } from "@/lib/auth/buyer-auth";
import {
  sendCancelRequestNotificationToWholesaler,
  sendCreditLimitExceededNotificationToRetailer,
  sendCreditLimitExceededNotificationToWholesaler,
  sendOrderNotificationToWholesaler,
} from "@/lib/notifications/alimtalk";
import { canRequestCancel } from "@/lib/orders/status";
import { isShopNotFoundError, loadShopCatalog, toCartLines, type CartEntryInput } from "@/lib/shop/catalog";
import { fetchShopOrderPage } from "@/lib/shop/order-history";
import { validateCancelReason, type ShopOrder } from "@/lib/shop/order-history-types";
import { validateCart } from "@/lib/shop/order-policy";
import { isRetailerNamePlaceholder } from "@/lib/shop/retailer-placeholder";
import { createOrderWithItems, buildOrderNumber, discardUnfulfilledOrder } from "@/lib/orders/create-order";
import { reconcileStalePgPaymentsForRetailer } from "@/lib/payments/pg-reconcile";
import { fetchTrackingStatus, type TrackingResult } from "@/lib/verification/sweettracker";
import { composeProductDisplayName } from "@/lib/products/display-name";
import { signExternalOpenToken } from "@/lib/pdf/external-open-token";
import type { OrderStatus, PaymentMethod } from "@/types/database";

export interface SubmitOrderInput {
  shopToken: string;
  /** 상품ID + 수량만 전달받고 단가/금액은 서버 카탈로그에서 재계산한다. */
  items: CartEntryInput[];
  restaurantName: string;
  contactPhone: string;
  deliveryAddress: string;
  deliveryNotes?: string;
  /** 미지정 시 prepaid(즉시결제)로 처리 */
  paymentMethod?: PaymentMethod;
  /** 가격 관련 요청 메모 (네고 켜진 공급사만 의미 있음) */
  negotiationNote?: string;
}

export interface SubmitOrderResult {
  success: boolean;
  error?: string;
  orderNumber?: string;
  totalAmount?: number;
  itemsSummary?: string;
  notificationId?: string;
  /** 카카오 로그인/단골 등록이 필요한 상태 (클라이언트가 게이트를 띄울 수 있도록) */
  requiresAuth?: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  if (isRetailerNamePlaceholder(buyer.restaurantName)) {
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
 * 여신 한도 초과로 외상 주문이 거절됐을 때 도매업자 + 바이어 양쪽에 알림톡을 보낸다.
 * 사전 체크(빠른 실패)와 apply_credit_order RPC 백스톱 두 경로 모두에서 호출된다.
 * 바이어에게는 "여신 한도"라는 용어/금액을 노출하지 않는다(정책 결정).
 */
async function notifyCreditLimitExceeded(
  supabase: SupabaseServerClient,
  buyer: LinkedBuyer,
  restaurantName: string,
  attemptedAmount: number
): Promise<void> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", buyer.wholesalerProfileId)
    .maybeSingle();

  await Promise.all([
    sendCreditLimitExceededNotificationToWholesaler({
      wholesalerId: buyer.wholesalerId,
      wholesalerName: buyer.wholesalerName,
      wholesalerPhone: (profile?.phone as string | undefined) ?? undefined,
      restaurantName,
      creditLimit: buyer.creditLimit,
      outstandingBalance: buyer.outstandingBalance,
      attemptedAmount,
    }),
    sendCreditLimitExceededNotificationToRetailer({
      wholesalerId: buyer.wholesalerId,
      wholesalerName: buyer.wholesalerName,
      retailerName: restaurantName,
      retailerPhone: buyer.contactPhone ?? undefined,
    }),
  ]);
}

/**
 * 발주서 최종 제출.
 * 1) 서버 카탈로그로 단가 재해석 → 2) 최소 주문 금액/수량·재고 검증 →
 * 3) auth.uid() 기반 바이어 신원·거래 관계 검증 → 4) orders/order_items 저장
 * (외상 주문이면 apply_credit_order RPC로 미수금 잔액도 원자적으로 반영) →
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
    const validation = validateCart(lines, Number(catalog.wholesaler.min_order_amount));

    if (!validation.ok) {
      return { success: false, error: validation.violations[0].message };
    }

    // 공급사가 네고를 꺼둔 경우 메모도 함께 무시한다 — UI를 숨기는 것만으로는
    // 부족하다(설정은 항상 서버 기준이 최종 권한, requestedUnitPrice와 동일한 판단).
    const negotiationNote =
      catalog.wholesaler.allow_price_negotiation && input.negotiationNote?.trim()
        ? input.negotiationNote.trim()
        : null;

    if (input.paymentMethod === "pg") {
      return {
        success: false,
        error: "PG 결제는 이 경로로 접수되지 않습니다. 결제창을 통해 다시 시도해주세요.",
      };
    }

    const totalAmount = validation.totals.totalAmount;
    const orderNumber = buildOrderNumber();
    const paymentMethod: PaymentMethod = input.paymentMethod === "on_credit" ? "on_credit" : "prepaid";
    const supabase = await createClient();

    const buyer = await requireLinkedBuyer(supabase, input.shopToken);

    // 1) 발주서 저장
    if (paymentMethod === "on_credit") {
      if (buyer.creditLimit <= 0) {
        return {
          success: false,
          error: "이 거래처는 외상 거래가 허용되지 않았습니다. 공급사에 문의해주세요.",
        };
      }

      // 빠른 실패용 사전 검증. 동시 주문에 의한 한도 초과는 apply_credit_order RPC가
      // 원자적으로 다시 막는다 (아래 3번 단계).
      if (buyer.outstandingBalance + totalAmount > buyer.creditLimit) {
        await notifyCreditLimitExceeded(supabase, buyer, restaurantName, totalAmount);

        return {
          success: false,
          error: "여신 한도를 초과하여 발주할 수 없습니다. 미수금 정산 후 다시 시도해주세요.",
        };
      }
    }

    await backfillRetailerProfile(supabase, buyer, {
      restaurantName,
      contactPhone,
      deliveryAddress,
    });

    const createResult = await createOrderWithItems(supabase, {
      wholesalerId: buyer.wholesalerId,
      retailerId: buyer.retailerId,
      orderNumber,
      totalAmount,
      deliveryAddress,
      deliveryNotes,
      paymentMethod,
      lines,
      negotiationNote,
    });

    if ("error" in createResult) {
      return { success: false, error: createResult.error };
    }

    const orderId = createResult.orderId;

    // 3) 외상 주문이면 미수금 잔액을 원자적으로 증가시킨다 (한도 재검증 포함).
    if (paymentMethod === "on_credit") {
      const { error: creditError } = await supabase.rpc("apply_credit_order", {
        p_wholesaler_retailer_id: buyer.relationshipId,
        p_amount: totalAmount,
      });

      if (creditError) {
        // 잔액 반영에 실패한 외상 주문은 남겨두지 않는다 (품목·소진된 핫딜 한도까지 함께 정리).
        await discardUnfulfilledOrder(supabase, orderId);

        const isCreditLimitExceeded = creditError.message.includes("CREDIT_LIMIT_EXCEEDED");

        if (isCreditLimitExceeded) {
          await notifyCreditLimitExceeded(supabase, buyer, restaurantName, totalAmount);
        }

        return {
          success: false,
          error: isCreditLimitExceeded
            ? "여신 한도를 초과하여 발주할 수 없습니다. 미수금 정산 후 다시 시도해주세요."
            : "외상 잔액 반영에 실패했습니다. 잠시 후 다시 시도해주세요.",
        };
      }
    }

    // 4) 알림톡 품목 요약 ("소 한우 1++ 등심 2kg 외 1건")
    const [firstLine] = lines;
    const firstLineDisplayName = composeProductDisplayName(firstLine.category, firstLine.name);
    const itemsSummary =
      lines.length > 1
        ? `${firstLineDisplayName} ${firstLine.quantity}${firstLine.unit} 외 ${lines.length - 1}건`
        : `${firstLineDisplayName} ${firstLine.quantity}${firstLine.unit}`;

    // 5) 공급사 대표 연락처 조회 후 카카오 알림톡 발송
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone")
      .eq("id", buyer.wholesalerProfileId)
      .maybeSingle();

    const wholesalerPhone = (profile?.phone as string | undefined) ?? undefined;

    const notification = await sendOrderNotificationToWholesaler({
      wholesalerId: buyer.wholesalerId,
      wholesalerName: buyer.wholesalerName,
      wholesalerPhone,
      restaurantName,
      orderNumber,
      itemsSummary,
      totalAmount,
      deliveryAddress,
      deliveryNotes,
    });

    revalidatePath("/dashboard/orders");
    revalidatePath(`/shop/${input.shopToken}`);
    revalidatePath(`/shop/${input.shopToken}/orders`);

    return {
      success: true,
      orderNumber,
      totalAmount,
      itemsSummary,
      notificationId: notification.messageId,
    };
  } catch (error: unknown) {
    // loadShopCatalog()가 던지는 notFound()는 이 try/catch가 가로채므로, 여기서
    // 먼저 걸러내지 않으면 Next.js 내부 digest 문자열이 그대로 노출된다.
    if (isShopNotFoundError(error)) {
      return {
        success: false,
        error: "이 미니샵 링크가 더 이상 유효하지 않습니다. 공급사에 문의해주세요.",
      };
    }

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
          : "발주 처리 중 알 수 없는 오류가 발생했습니다.",
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
          "취소 요청을 접수하지 못했습니다. 발주 상태가 방금 변경되었을 수 있으니 발주 내역을 새로고침한 뒤 다시 시도해주세요.",
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
      wholesalerId: buyer.wholesalerId,
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

// ====================================================================
// 배송 조회 (스위트트래커) — 바이어
// ====================================================================

export interface FetchBuyerTrackingStatusResult {
  success: boolean;
  error?: string;
  data?: TrackingResult;
}

/** 바이어 본인 주문의 저장된 운송장번호로 배송 상태를 라이브 조회한다. */
export async function fetchBuyerTrackingStatusAction(
  shopToken: string,
  orderId: string
): Promise<FetchBuyerTrackingStatusResult> {
  try {
    if (!UUID_PATTERN.test(shopToken ?? "") || !UUID_PATTERN.test(orderId ?? "")) {
      return { success: false, error: "올바른 요청이 아닙니다." };
    }

    const supabase = await createClient();
    const buyer = await requireLinkedBuyer(supabase, shopToken);

    const { data: order } = await supabase
      .from("orders")
      .select("courier_code, tracking_number")
      .eq("id", orderId)
      .eq("wholesaler_id", buyer.wholesalerId)
      .eq("retailer_id", buyer.retailerId)
      .maybeSingle();

    if (!order) {
      return { success: false, error: "해당 발주서를 찾을 수 없습니다." };
    }

    if (!order.courier_code || !order.tracking_number) {
      return { success: false, error: "아직 등록된 운송장번호가 없습니다." };
    }

    const result = await fetchTrackingStatus(
      order.courier_code as string,
      order.tracking_number as string
    );

    return { success: true, data: result };
  } catch (error: unknown) {
    if (error instanceof BuyerAuthError) {
      return { success: false, error: error.message };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "배송 조회 중 오류가 발생했습니다.",
    };
  }
}

// ====================================================================
// 주문 내역 조회 구간 변경 / 더보기 — 바이어
// ====================================================================

export interface LoadShopOrderHistoryPageResult {
  success: boolean;
  error?: string;
  data?: {
    orders: ShopOrder[];
    totalCount: number;
    hasMore: boolean;
    /** 카카오 인앱 브라우저 "외부에서 열기" 전용 토큰 경로(/doc/[token]). 발급 안 되면 생략(기존 href 폴백). */
    statementExternalOpenHrefByOrderId: Record<string, string>;
  };
}

/**
 * 초기 페이지 로드(order-history.ts의 loadShopOrderHistory) 이후, 조회 구간(30일/3개월/전체)을
 * 바꾸거나 "더보기"를 누를 때 클라이언트에서 호출한다. shopToken으로 재확인한 본인 발주만
 * 조회되므로 남의 발주서를 offset/rangeDays 조작으로 엿볼 수 없다.
 */
export async function loadShopOrderHistoryPageAction(
  shopToken: string,
  rangeDays: number | null,
  offset = 0
): Promise<LoadShopOrderHistoryPageResult> {
  try {
    if (!UUID_PATTERN.test(shopToken ?? "")) {
      return { success: false, error: "올바른 미니샵 주소가 아닙니다." };
    }

    const supabase = await createClient();
    const buyer = await requireLinkedBuyer(supabase, shopToken);

    // 결제 승인 콜백이 브라우저 이탈 등으로 끊겼을 때의 안전망 — 고객이 주문내역을
    // 다시 열 때 3분 넘게 그대로인 결제건이 있으면 여기서 뒤늦게라도 정리한다.
    await reconcileStalePgPaymentsForRetailer(supabase, buyer.wholesalerId, buyer.retailerId);

    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

    const { orders, totalCount, hasMore, error } = await fetchShopOrderPage(
      supabase,
      buyer.wholesalerId,
      buyer.retailerId,
      { rangeDays, offset: safeOffset }
    );

    if (error) {
      return { success: false, error };
    }

    const statementExternalOpenHrefByOrderId: Record<string, string> = {};

    for (const order of orders) {
      const token = signExternalOpenToken({
        kind: "buyer-statement",
        orderId: order.id,
        wholesalerId: buyer.wholesalerId,
        retailerId: buyer.retailerId,
      });

      if (token) {
        statementExternalOpenHrefByOrderId[order.id] = `/doc/${token}`;
      }
    }

    return {
      success: true,
      data: { orders, totalCount, hasMore, statementExternalOpenHrefByOrderId },
    };
  } catch (error: unknown) {
    if (error instanceof BuyerAuthError) {
      return { success: false, error: error.message };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "주문 내역 조회 중 오류가 발생했습니다.",
    };
  }
}
