import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { fetchSubcategoriesByCategory } from "../products/get-subcategories";
import { loadProductOptions } from "@/lib/purchase-orders/load-product-options";
import type { ProductOption } from "@/lib/purchase-orders/product-match";
import { PurchaseOrderView, type PurchaseOrderRow, type SupplierRow } from "./purchase-order-view";

export const metadata = {
  title: "발주 관리 | 도매업체 통합관리시스템",
};

const RECENT_LIMIT = 60;

/** 공급사가 공급처에 내는 발주서 — 화면에서 적거나 엑셀 양식을 내려받아 채워 올린다. */
export default async function PurchaseOrdersPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  const canManage = Boolean(
    scope &&
      (scope.isSuperAdmin ||
        scope.orgRole === "owner" ||
        scope.orgRole === "manager" ||
        (!scope.organizationId && scope.wholesalerId))
  );

  let orders: PurchaseOrderRow[] = [];
  let suppliers: SupplierRow[] = [];
  let categories: string[] = [];
  let subcategoriesByCategory: Record<string, string[]> = {};
  let products: ProductOption[] = [];
  let recentProductIds: string[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const [{ data: orderRows }, { data: categoryRows }, subcategories, { data: supplierRows }, productOptions] = await Promise.all([
      supabase
        .from("purchase_orders")
        .select(
          "id, supplier_id, supplier_name, ordered_on, expected_on, note, status, purchase_order_lines ( line_no, product_id, category, subcategory, grade, origin, quantity, unit, unit_price )"
        )
        .eq("wholesaler_id", scope.wholesalerId)
        .order("ordered_on", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT),
      supabase.from("product_categories").select("name").order("sort_order", { ascending: true }),
      fetchSubcategoriesByCategory(supabase),
      supabase
        .from("suppliers")
        .select("id, name, phone, note, aliases, is_active")
        .eq("wholesaler_id", scope.wholesalerId)
        .order("name", { ascending: true }),
      loadProductOptions(supabase, scope.wholesalerId),
    ]);

    orders = ((orderRows ?? []) as unknown as PurchaseOrderRow[]).map((order) => ({
      ...order,
      purchase_order_lines: [...(order.purchase_order_lines ?? [])].sort((a, b) => a.line_no - b.line_no),
    }));
    categories = ((categoryRows ?? []) as Array<{ name: string }>).map((row) => row.name);
    subcategoriesByCategory = subcategories;
    products = productOptions;
    recentProductIds = [
      ...new Set(orders.flatMap((order) => order.purchase_order_lines.map((line) => line.product_id).filter((id): id is string => Boolean(id)))),
    ];
    suppliers = ((supplierRows ?? []) as unknown as SupplierRow[]).map((row) => ({ ...row, aliases: row.aliases ?? [] }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>발주 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          공급처에 발주한 품목과 수량(예: 소 등심 1++ 국내산 50kg)을 적어 둡니다. 공급처는 아래 거래처 목록에서 고르고,
          품목은 등록된 품목을 한 줄로 검색해 고르거나(없으면 그 자리에서 새 품목 만들기) 엑셀 양식을 내려받아 채워 올리면 됩니다. 물건이 도착했을 때 이 발주서와 맞춰 보는 기능은 다음 단계에서 붙입니다.
        </p>
      </header>

      <PurchaseOrderView
        canManage={canManage}
        categories={categories}
        subcategoriesByCategory={subcategoriesByCategory}
        suppliers={suppliers}
        orders={orders}
        products={products}
        recentProductIds={recentProductIds}
      />
    </div>
  );
}
