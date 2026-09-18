"use server";

import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";
import { BuyerAuthError, requireLinkedBuyer } from "@/lib/auth/buyer-auth";
import { loadShopCatalog, toCartLines, type CartEntryInput } from "@/lib/shop/catalog";
import { validateCart } from "@/lib/shop/order-policy";

/**
 * PG(토스페이먼츠) 결제 시작 — "결제 확정 후에만 실제 주문 생성" 원칙에 따라
 * orders에는 아직 아무것도 쓰지 않는다. 장바구니/배송정보를 pg_pending_payments에
 * 임시 저장하고, 프론트가 이 값으로 토스 결제창을 띄운다. 실제 주문 생성은
 * checkout/pg/success/route.ts(결제 승인 성공 콜백)에서만 일어난다.
 */

export interface InitiatePgPaymentInput {
  shopToken: string;
  items: CartEntryInput[];
  restaurantName: string;
  contactPhone: string;
  deliveryAddress: string;
  deliveryNotes?: string;
}

export interface InitiatePgPaymentResult {
  success: boolean;
  error?: string;
  requiresAuth?: boolean;
  pgOrderId?: string;
  amount?: number;
  clientKey?: string;
  orderName?: string;
}

function buildPgOrderId(): string {
  return `pg${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function initiatePgPaymentAction(
  input: InitiatePgPaymentInput
): Promise<InitiatePgPaymentResult> {
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

    if (catalog.isDemo) {
      return { success: false, error: "데모(샘플) 화면에서는 PG 결제를 테스트할 수 없습니다." };
    }

    const lines = toCartLines(catalog, input.items ?? []);
    const validation = validateCart(lines);

    if (!validation.ok) {
      return { success: false, error: validation.violations[0].message };
    }

    const totalAmount = validation.totals.totalAmount;
    const supabase = await createClient();
    const buyer = await requireLinkedBuyer(supabase, input.shopToken);

    if (!buyer.allowedPaymentMethods.includes("pg")) {
      return {
        success: false,
        error: "이 거래처는 PG 결제가 허용되지 않았습니다. 공급사에 문의해주세요.",
      };
    }

    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("pg_client_key")
      .eq("id", buyer.wholesalerId)
      .maybeSingle();

    const clientKey = (wholesaler?.pg_client_key as string | null) ?? null;

    if (!clientKey) {
      return {
        success: false,
        error: "이 공급사는 아직 PG 결제 연동이 설정되지 않았습니다. 다른 결제수단을 이용해주세요.",
      };
    }

    const pgOrderId = buildPgOrderId();

    const { error: insertError } = await supabase.from("pg_pending_payments").insert({
      pg_order_id: pgOrderId,
      wholesaler_id: buyer.wholesalerId,
      retailer_id: buyer.retailerId,
      total_amount: totalAmount,
      cart_snapshot: lines,
      restaurant_name: restaurantName,
      contact_phone: contactPhone,
      delivery_address: deliveryAddress,
      delivery_notes: deliveryNotes,
    });

    if (insertError) {
      return { success: false, error: "결제 준비에 실패했습니다. 잠시 후 다시 시도해주세요." };
    }

    const [firstLine] = lines;
    const orderName =
      lines.length > 1 ? `${firstLine.name} 외 ${lines.length - 1}건` : firstLine.name;

    return {
      success: true,
      pgOrderId,
      amount: totalAmount,
      clientKey,
      orderName,
    };
  } catch (error) {
    if (error instanceof BuyerAuthError) {
      return { success: false, error: error.message, requiresAuth: error.code === "auth_required" };
    }

    console.error("[PG Initiate ERROR]", error);

    return {
      success: false,
      error: error instanceof Error ? error.message : "결제 준비 중 알 수 없는 오류가 발생했습니다.",
    };
  }
}
