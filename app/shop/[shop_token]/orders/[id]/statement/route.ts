import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { BuyerAuthError, requireLinkedBuyer } from "@/lib/auth/buyer-auth";
import { loadStatementDataForBuyer } from "@/lib/orders/statement";
import { buildStatementResponse } from "@/lib/pdf/statement-response";

// @react-pdf/renderer는 Node.js API(fs 등)에 의존해 Edge 런타임에서 동작하지 않는다.
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ shop_token: string; id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { shop_token: shopToken, id } = await params;
  const supabase = await createClient();

  try {
    // shop_token → 활성 거래 관계 → retailer_id 를 서버에서 재확인한다.
    // 이 주문이 실제로 이 바이어·이 공급사의 것인지는 loadStatementDataForBuyer가
    // wholesaler_id + retailer_id 둘 다로 다시 필터링해 교차 조회를 막는다.
    const buyer = await requireLinkedBuyer(supabase, shopToken);
    const data = await loadStatementDataForBuyer(supabase, id, buyer.wholesalerId, buyer.retailerId);

    if (!data) {
      return NextResponse.json({ error: "주문을 찾을 수 없습니다." }, { status: 404 });
    }

    return await buildStatementResponse(data, {
      note: "공급사가 아직 사업장 주소를 등록하지 않았습니다. 공급사에 등록을 요청해주세요.",
    });
  } catch (error) {
    if (error instanceof BuyerAuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    throw error;
  }
}
