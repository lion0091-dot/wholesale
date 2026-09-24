import { NextResponse, type NextRequest } from "next/server";

interface RouteParams {
  params: Promise<{ shop_token: string }>;
}

/**
 * 토스페이먼츠 결제창 failUrl 콜백 — 승인 API를 부르기 전 단계에서 실패한 경우
 * (카드 한도 초과, 사용자가 결제창을 닫음 등). 아직 orders는 생성된 적이 없다.
 *
 * pg_pending_payments는 여기서 지우지 않는다(2026-09-24 점검 3). 실패 URL은
 * 브라우저가 부르는 것이라, 결제가 실제로 잡힌 뒤 이 URL이 호출되는 경우(두 탭·
 * 뒤로가기·조작)에 대기 행을 지우면 재대조(lib/payments/pg-reconcile.ts)가
 * 그 결제를 복구할 근거를 잃는다. 대기 행은 30분 뒤 재대조가 토스 상태를 보고
 * 알아서 정리한다 — 결제가 없었으면 버리고, 있었으면 주문을 만든다.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { shop_token: shopToken } = await params;
  const url = new URL(request.url);
  const message = url.searchParams.get("message") ?? "결제가 취소되었습니다.";

  return NextResponse.redirect(
    new URL(`/shop/${shopToken}/checkout?pgError=${encodeURIComponent(message)}`, request.url)
  );
}
