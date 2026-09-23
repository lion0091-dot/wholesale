import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { QuickStockView, type QuickStockRow } from "./quick-stock-view";

export const metadata = {
  title: "재고 확인 | 도매업체 통합관리시스템",
};

/**
 * 모바일 현장용 재고 확인 — 상품 관리(/dashboard/products) 화면은 카탈로그 편집까지
 * 같이 있어 폰에서 "지금 몇 개 남았지"만 보기엔 무겁다. 여긴 읽기 전용으로 숫자만 보여준다.
 * 재고 숫자 자체는 products.stock_quantity(원장 합계, recalc_product_stock()가 유지)를
 * 그대로 읽는다 — 별도 집계 로직 없음.
 */
export default async function QuickStockPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let rows: QuickStockRow[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();

    const { data } = await supabase
      .from("products")
      .select("id, name, category, subcategory, grade, unit, stock_quantity")
      .eq("wholesaler_id", scope.wholesalerId)
      .eq("is_active", true)
      .order("name", { ascending: true });

    rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      category: (row.category as string | null) ?? null,
      subcategory: (row.subcategory as string | null) ?? null,
      grade: (row.grade as string | null) ?? null,
      unit: String(row.unit),
      stockQuantity: Number(row.stock_quantity ?? 0),
    }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>재고 확인</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          지금 재고 수량만 빠르게 확인합니다. 재고를 고치려면 상품 관리 화면을 이용하세요.
        </p>
      </header>

      <QuickStockView rows={rows} />
    </div>
  );
}
