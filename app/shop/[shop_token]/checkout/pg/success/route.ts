import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { BuyerAuthError, requireLinkedBuyer } from "@/lib/auth/buyer-auth";
import { confirmPayment, TossPaymentsError } from "@/lib/payments/tosspayments-client";
import { decryptCredential, CredentialCryptoError } from "@/lib/security/credential-crypto";
import { finalizePaidOrder, type PendingPgPaymentRow } from "@/lib/payments/pg-reconcile";
import type { CartLine } from "@/lib/shop/order-policy";

// 토스 결제 승인 API는 Node crypto(lib/security/credential-crypto.ts)를 쓰므로 Edge에서 못 돈다.
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ shop_token: string }>;
}

/**
 * 토스페이먼츠 결제창 successUrl 콜백.
 *
 * "결제 확정 후에만 실제 주문 생성" 원칙의 핵심 라우트 — pg_pending_payments에
 * 임시 저장해둔 장바구니를 여기서 실제 orders/order_items로 옮겨 심는다. 승인
 * API 호출 전에 금액을 반드시 대조한다(토스 공식 경고 — 클라이언트가 넘긴 값이
 * 아니라 우리가 저장해둔 기대 금액과 비교해야 변조를 막을 수 있다).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { shop_token: shopToken } = await params;
  const url = new URL(request.url);
  const paymentKey = url.searchParams.get("paymentKey");
  const orderId = url.searchParams.get("orderId");
  const amountParam = url.searchParams.get("amount");

  const failRedirect = (message: string) =>
    NextResponse.redirect(
      new URL(`/shop/${shopToken}/checkout?pgError=${encodeURIComponent(message)}`, request.url)
    );

  if (!paymentKey || !orderId || !amountParam) {
    return failRedirect("결제 승인에 필요한 정보가 없습니다.");
  }

  const amount = Number(amountParam);

  if (!Number.isFinite(amount) || amount <= 0) {
    return failRedirect("결제 금액이 올바르지 않습니다.");
  }

  try {
    const supabase = await createClient();
    const buyer = await requireLinkedBuyer(supabase, shopToken);

    const { data: pendingRow } = await supabase
      .from("pg_pending_payments")
      .select(
        "id, pg_order_id, wholesaler_id, retailer_id, total_amount, cart_snapshot, restaurant_name, contact_phone, delivery_address, delivery_notes, negotiation_note, expires_at"
      )
      .eq("pg_order_id", orderId)
      .eq("retailer_id", buyer.retailerId)
      .maybeSingle();

    if (!pendingRow) {
      return failRedirect("결제 요청을 찾을 수 없습니다. 다시 시도해주세요.");
    }

    const pending = pendingRow as unknown as PendingPgPaymentRow & { cart_snapshot: CartLine[] };

    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await supabase.from("pg_pending_payments").delete().eq("id", pending.id);
      return failRedirect("결제 유효시간이 만료되었습니다. 다시 시도해주세요.");
    }

    // 클라이언트/URL로 넘어온 amount가 아니라 우리가 저장해둔 기대 금액과 대조한다.
    if (Number(pending.total_amount) !== amount) {
      return failRedirect("결제 금액이 일치하지 않습니다. 공급사에 문의해주세요.");
    }

    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("pg_secret_key_encrypted")
      .eq("id", pending.wholesaler_id)
      .maybeSingle();

    const encryptedSecret = wholesaler?.pg_secret_key_encrypted as string | null;

    if (!encryptedSecret) {
      return failRedirect("공급사의 PG 연동 설정을 확인할 수 없습니다.");
    }

    const secretKey = decryptCredential(encryptedSecret);

    const confirmed = await confirmPayment({
      secretKey,
      paymentKey,
      orderId,
      amount,
    });

    const result = await finalizePaidOrder(supabase, pending, {
      paymentKey: confirmed.paymentKey,
      totalAmount: amount,
    });

    if ("error" in result) {
      // 결제는 이미 승인됐는데 주문 생성이 실패한 경우 — 돈은 받았으니 절대 조용히
      // 묻으면 안 된다. pg_pending_payments는 지우지 않고 남겨서(finalizePaidOrder가
      // 실패 시 안 지움), 다음 페이지 방문/매일 크론의 복구 대상에 들어가게 한다.
      return failRedirect(
        `결제는 완료됐지만 발주 저장에 실패했습니다(결제키: ${confirmed.paymentKey}). 공급사에 문의해주세요.`
      );
    }

    return NextResponse.redirect(
      new URL(`/shop/${shopToken}/orders?paid=1&order=${encodeURIComponent(result.orderNumber)}`, request.url)
    );
  } catch (error) {
    if (error instanceof BuyerAuthError) {
      return failRedirect(error.message);
    }

    if (error instanceof TossPaymentsError) {
      return failRedirect(`결제 승인에 실패했습니다: ${error.message}`);
    }

    if (error instanceof CredentialCryptoError) {
      return failRedirect("결제 연동 설정 오류입니다. 공급사에 문의해주세요.");
    }

    console.error("[PG Success ERROR]", error);
    return failRedirect("결제 처리 중 알 수 없는 오류가 발생했습니다.");
  }
}
