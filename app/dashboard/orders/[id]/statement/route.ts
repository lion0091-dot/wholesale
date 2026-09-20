import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { loadStatementDataForSupplier, type StatementData } from "@/lib/orders/statement";
import { buildStatementResponse } from "@/lib/pdf/statement-response";
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
    supplier: {
      name: "마장동 태양축산 (테스트 도매)",
      representativeName: "김도매",
      businessNumber: "123-45-67890",
      // 데모는 항상 발행 가능한 상태를 보여준다 — 주소 누락 가드(findMissingStatementFields)는
      // 실제 미등록 공급사 시나리오에서만 걸리도록 샘플 주소를 채워둔다.
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

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const scope = await getSupplierScope();
  const download = request.nextUrl.searchParams.get("download") === "1";

  // 실계정인데 아직 실주문이 없으면 /dashboard/orders/[id] 페이지와 동일하게
  // 샘플 주문으로 폴백한다 (그렇지 않으면 화면엔 샘플 주문이 보이는데 명세서만 404가 난다).
  const data =
    (scope?.wholesalerId
      ? await loadStatementDataForSupplier(await createClient(), id, scope.wholesalerId)
      : null) ?? buildDemoStatement(id);

  if (!data) {
    return NextResponse.json({ error: "발주를 찾을 수 없습니다." }, { status: 404 });
  }

  return buildStatementResponse(
    data,
    {
      actionHref: "/dashboard/invites",
      actionLabel: "사업장 주소 등록하러 가기",
    },
    download
  );
}
