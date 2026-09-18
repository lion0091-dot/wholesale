import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireLinkedBuyer } from "@/lib/auth/buyer-auth";

interface RouteParams {
  params: Promise<{ shop_token: string }>;
}

/**
 * 토스페이먼츠 결제창 failUrl 콜백 — 승인 API를 부르기 전 단계에서 실패한 경우
 * (카드 한도 초과, 사용자가 결제창을 닫음 등). 아직 orders는 생성된 적이 없으므로
 * pg_pending_payments만 정리하고 체크아웃으로 돌려보낸다.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { shop_token: shopToken } = await params;
  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId");
  const message = url.searchParams.get("message") ?? "결제가 취소되었습니다.";

  try {
    if (orderId) {
      const supabase = await createClient();
      const buyer = await requireLinkedBuyer(supabase, shopToken);

      await supabase
        .from("pg_pending_payments")
        .delete()
        .eq("pg_order_id", orderId)
        .eq("retailer_id", buyer.retailerId);
    }
  } catch {
    // 정리 실패는 무해하다 — 만료(30분) 후 방치돼도 재고/락에 영향 없는 메타데이터.
  }

  return NextResponse.redirect(
    new URL(`/shop/${shopToken}/checkout?pgError=${encodeURIComponent(message)}`, request.url)
  );
}
