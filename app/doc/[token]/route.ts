import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { verifyExternalOpenToken } from "@/lib/pdf/external-open-token";
import { loadStatementDataForSupplier, loadStatementDataForBuyer } from "@/lib/orders/statement";
import { buildStatementResponse } from "@/lib/pdf/statement-response";
import { buildTaxInvoiceResponse } from "@/lib/pdf/tax-invoice-response";
import type { TaxInvoiceOverrides } from "@/lib/pdf/tax-invoice";
import { loadDeliveryRequestDataForSupplier } from "@/lib/orders/delivery-request";
import { buildDeliveryRequestResponse } from "@/lib/pdf/delivery-request-response";

/**
 * 카카오톡 인앱 브라우저 → "외부 브라우저에서 열기" 전용 공개 라우트.
 *
 * /dashboard, /shop/<token> 라우트는 세션 쿠키(Supabase Auth)로 인가하는데, 카카오
 * 인앱에서 시스템 브라우저(Safari 등)로 넘어가면 완전히 다른 쿠키 저장소라 세션이
 * 사라져 로그인 화면으로 튕긴다. 이 라우트는 세션 대신 서명 토큰(단발성, TTL 있음)
 * 하나로만 인가하고, service_role로 조회해 RLS(세션 없음)에 걸리지 않게 한다.
 * 토큰은 렌더링 시점에 이미 인가된 서버(원래 페이지)만 만들 수 있으므로 안전하다.
 *
 * 미들웨어 경로 접두사(/dashboard, /admin)에 걸리지 않는 독립 경로다 — 의도적으로
 * middleware.ts를 건드리지 않기 위해 여기로 뺐다.
 */

// @react-pdf/renderer는 Node.js API(fs 등)에 의존해 Edge 런타임에서 동작하지 않는다.
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ token: string }>;
}

function invalidLinkResponse() {
  return new NextResponse(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="font-family:-apple-system,sans-serif;padding:60px 20px;text-align:center;color:#334155;">
<p style="font-size:15px;line-height:1.8;">링크가 만료되었거나 유효하지 않습니다.<br />앱으로 돌아가서 다시 열어주세요.</p>
</body></html>`,
    { status: 410, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function parseOverrides(searchParams: URLSearchParams, fallbackDate: string): TaxInvoiceOverrides {
  return {
    issueDate: searchParams.get("issueDate") || fallbackDate,
    supplierBusinessType: (searchParams.get("supplierBusinessType") || "").slice(0, 40),
    supplierBusinessItem: (searchParams.get("supplierBusinessItem") || "").slice(0, 40),
    buyerBusinessType: (searchParams.get("buyerBusinessType") || "").slice(0, 40),
    buyerBusinessItem: (searchParams.get("buyerBusinessItem") || "").slice(0, 40),
    note: (searchParams.get("note") || "").slice(0, 200),
  };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  const payload = verifyExternalOpenToken(token);

  if (!payload) {
    return invalidLinkResponse();
  }

  const supabase = createServiceRoleClient();

  if (!supabase) {
    return invalidLinkResponse();
  }

  if (payload.kind === "buyer-statement") {
    if (!payload.wholesalerId || !payload.retailerId) {
      return invalidLinkResponse();
    }

    const data = await loadStatementDataForBuyer(
      supabase,
      payload.orderId,
      payload.wholesalerId,
      payload.retailerId
    );

    if (!data) {
      return NextResponse.json({ error: "발주를 찾을 수 없습니다." }, { status: 404 });
    }

    return buildStatementResponse(data, {
      note: "공급사가 아직 사업장 주소를 등록하지 않았습니다. 공급사에 등록을 요청해주세요.",
    });
  }

  // supplier-statement / tax-invoice / delivery-request — 전부 공급사 소유(wholesalerId) 기준 조회
  if (!payload.wholesalerId) {
    return invalidLinkResponse();
  }

  if (payload.kind === "delivery-request") {
    const deliveryData = await loadDeliveryRequestDataForSupplier(
      supabase,
      payload.orderId,
      payload.wholesalerId
    );

    if (!deliveryData) {
      return NextResponse.json({ error: "발주를 찾을 수 없습니다." }, { status: 404 });
    }

    return buildDeliveryRequestResponse(deliveryData, {
      actionHref: "/dashboard/invites",
      actionLabel: "사업장 주소 등록하러 가기",
    });
  }

  const data = await loadStatementDataForSupplier(supabase, payload.orderId, payload.wholesalerId);

  if (!data) {
    return NextResponse.json({ error: "발주를 찾을 수 없습니다." }, { status: 404 });
  }

  if (payload.kind === "tax-invoice") {
    const overrides = parseOverrides(request.nextUrl.searchParams, data.orderedAt.slice(0, 10));

    return buildTaxInvoiceResponse(data, overrides, {
      actionHref: "/dashboard/invites",
      actionLabel: "사업장 주소 등록하러 가기",
    });
  }

  return buildStatementResponse(data, {
    actionHref: "/dashboard/invites",
    actionLabel: "사업장 주소 등록하러 가기",
  });
}
