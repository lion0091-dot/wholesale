import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { buildTaxInvoiceCsv, fetchTaxInvoiceSummary, type TaxInvoiceCsvKind } from "@/lib/supplier/tax-invoice-summary";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FILE_LABEL: Record<TaxInvoiceCsvKind, string> = {
  months: "월별",
  retailers: "거래처별",
  todo: "챙길주문",
};

/**
 * 계산서 집계 한 표를 CSV로 내려받는다(엑셀에서 바로 열림). 권한·기능 켜짐·기간 검사는 DB 함수가 한다 —
 * 대표·매니저가 아니거나 탭이 꺼져 있으면 DB가 거부해 fetch가 null을 돌려주고 여기서 403이 된다.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const kind = params.get("kind") as TaxInvoiceCsvKind | null;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  if (!kind || !(kind in FILE_LABEL) || !DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const scope = await getSupplierScope();
  const result = scope?.wholesalerId ? await fetchTaxInvoiceSummary(await createClient(), { from, to }) : null;

  if (!result) {
    return NextResponse.json({ error: "계산서 집계를 볼 수 없습니다." }, { status: 403 });
  }

  const fileName = encodeURIComponent(`계산서집계_${FILE_LABEL[kind]}_${from}_${to}.csv`);

  return new NextResponse(buildTaxInvoiceCsv(kind, result), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${fileName}`,
      "Cache-Control": "no-store",
    },
  });
}
