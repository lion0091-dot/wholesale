import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { buildPurchaseOrderTemplate } from "@/lib/purchase-orders/template";
import { fetchSubcategoriesByCategory } from "../../products/get-subcategories";

export const runtime = "nodejs";

/** 공급처 발주서 입력 양식(.xlsx) 내려받기 — 로그인한 공급사 계정만. */
export async function GET() {
  const scope = await getSupplierScope();

  if (!scope?.wholesalerId) {
    return NextResponse.json({ error: "공급사 계정으로 로그인해야 받을 수 있습니다." }, { status: 401 });
  }

  const supabase = await createClient();
  const { data } = await supabase.from("product_categories").select("name").order("sort_order", { ascending: true });
  const categories = ((data ?? []) as Array<{ name: string }>).map((row) => row.name);
  const file = await buildPurchaseOrderTemplate(categories, await fetchSubcategoriesByCategory(supabase));
  const koreanName = encodeURIComponent("공급처전표_입력양식.xlsx");

  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="purchase-order-template.xlsx"; filename*=UTF-8''${koreanName}`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
