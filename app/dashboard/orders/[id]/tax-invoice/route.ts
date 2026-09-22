import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { loadStatementDataForSupplier, type StatementData } from "@/lib/orders/statement";
import { buildTaxInvoiceResponse } from "@/lib/pdf/tax-invoice-response";
import type { TaxInvoiceOverrides } from "@/lib/pdf/tax-invoice";
import { DEMO_ORDERS, DEMO_RETAILERS } from "@/lib/demo/supplier-samples";
import { composeProductDisplayName } from "@/lib/products/display-name";

// @react-pdf/renderer는 Node.js API(fs 등)에 의존해 Edge 런타임에서 동작하지 않는다.
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** 데모(미인증) 모드 — /dashboard/orders/[id] 페이지와 동일한 샘플 데이터로 미리보기 제공 */
function buildDemoStatement(orderId: string): StatementData | null {
  const order = DEMO_ORDERS.find((candidate) => candidate.id === orderId);

  if (!order) {
    return null;
  }

  const retailer = DEMO_RETAILERS.find((candidate) => candidate.id === order.retailer_id);

  return {
    orderId: order.id,
    orderNumber: order.order_number,
    status: order.status,
    orderedAt: order.ordered_at,
    deliveryAddress: order.delivery_address,
    deliveryNotes: order.delivery_notes,
    totalAmount: Number(order.total_amount),
    items: order.items.map((item) => ({
      productName: composeProductDisplayName(item.category, item.product_name),
      unitPrice: Number(item.unit_price),
      quantity: Number(item.quantity),
      subtotalAmount: Number(item.subtotal_amount),
    })),
    // 데모 주문은 실제 입고 스캔 이력이 없다 — 이력번호 없이 발행한다.
    traces: [],
    supplier: {
      name: "마장동 태양축산 (테스트 도매)",
      representativeName: "김도매",
      businessNumber: "123-45-67890",
      address: "서울 성동구 마장로 123, 2층 (샘플)",
      phone: null,
    },
    buyer: {
      name: order.retailer_name,
      representativeName: retailer?.representative_name ?? null,
      businessNumber: retailer?.business_number ?? null,
      address: retailer
        ? [retailer.delivery_address, retailer.delivery_address_detail].filter(Boolean).join(" ")
        : order.delivery_address,
      phone: null,
    },
  };
}

/** 쿼리스트링으로 받은 초안 수정값. 전부 사용자가 미리보기 화면에서 직접 입력한 값이라 서버는 형식만 다듬는다. */
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
  const { id } = await params;
  const scope = await getSupplierScope();

  // 실계정인데 아직 실주문이 없으면 /dashboard/orders/[id] 페이지와 동일하게
  // 샘플 주문으로 폴백한다 (app/dashboard/orders/[id]/statement/route.ts와 동일 패턴).
  const data =
    (scope?.wholesalerId
      ? await loadStatementDataForSupplier(await createClient(), id, scope.wholesalerId)
      : null) ?? buildDemoStatement(id);

  if (!data) {
    return NextResponse.json({ error: "발주를 찾을 수 없습니다." }, { status: 404 });
  }

  const overrides = parseOverrides(request.nextUrl.searchParams, data.orderedAt.slice(0, 10));

  return buildTaxInvoiceResponse(data, overrides, {
    actionHref: "/dashboard/invites",
    actionLabel: "사업장 주소 등록하러 가기",
  });
}
