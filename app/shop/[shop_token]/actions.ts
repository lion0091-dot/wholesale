"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendOrderNotificationToWholesaler } from "@/lib/notifications/alimtalk";
import { loadShopCatalog, toCartLines, type CartEntryInput } from "@/lib/shop/catalog";
import { lineSubtotal, validateCart } from "@/lib/shop/order-policy";

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
