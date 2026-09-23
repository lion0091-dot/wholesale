import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { loadStatementDataForSupplier } from "@/lib/orders/statement";
import { buildStatementResponse } from "@/lib/pdf/statement-response";

// @react-pdf/renderer는 Node.js API(fs 등)에 의존해 Edge 런타임에서 동작하지 않는다.
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const scope = await getSupplierScope();
  const download = request.nextUrl.searchParams.get("download") === "1";

  const data = scope?.wholesalerId
    ? await loadStatementDataForSupplier(await createClient(), id, scope.wholesalerId)
    : null;

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
