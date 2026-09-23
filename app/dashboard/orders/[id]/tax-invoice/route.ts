import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { loadStatementDataForSupplier } from "@/lib/orders/statement";
import { buildTaxInvoiceResponse } from "@/lib/pdf/tax-invoice-response";
import type { TaxInvoiceOverrides } from "@/lib/pdf/tax-invoice";

// @react-pdf/renderer는 Node.js API(fs 등)에 의존해 Edge 런타임에서 동작하지 않는다.
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
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

  const data = scope?.wholesalerId
    ? await loadStatementDataForSupplier(await createClient(), id, scope.wholesalerId)
    : null;

  if (!data) {
    return NextResponse.json({ error: "발주를 찾을 수 없습니다." }, { status: 404 });
  }

  const overrides = parseOverrides(request.nextUrl.searchParams, data.orderedAt.slice(0, 10));

  return buildTaxInvoiceResponse(data, overrides, {
    actionHref: "/dashboard/invites",
    actionLabel: "사업장 주소 등록하러 가기",
  });
}
