import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { ProductTabs } from "../section-tabs";
import { fetchSubcategoriesByCategory } from "../products/get-subcategories";
import { PurchaseOrderView, type PurchaseOrderRow } from "./purchase-order-view";

export const metadata = {
  title: "공급처 발주서 | 도매업체 통합관리시스템",
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
  let supplierSuggestions: string[] = [];
  let categories: string[] = [];
  let subcategoriesByCategory: Record<string, string[]> = {};

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const [{ data: orderRows }, { data: categoryRows }, subcategories, { data: documentSuppliers }] = await Promise.all([
      supabase
        .from("purchase_orders")
        .select(
          "id, supplier_name, ordered_on, expected_on, note, status, purchase_order_lines ( line_no, category, subcategory, grade, origin, quantity, unit, unit_price )"
        )
        .eq("wholesaler_id", scope.wholesalerId)
        .order("ordered_on", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT),
      supabase.from("product_categories").select("name").order("sort_order", { ascending: true }),
      fetchSubcategoriesByCategory(supabase),
      supabase.from("inbound_documents").select("supplier_name").eq("wholesaler_id", scope.wholesalerId).limit(200),
    ]);

    orders = ((orderRows ?? []) as unknown as PurchaseOrderRow[]).map((order) => ({
      ...order,
      purchase_order_lines: [...(order.purchase_order_lines ?? [])].sort((a, b) => a.line_no - b.line_no),
    }));
    categories = ((categoryRows ?? []) as Array<{ name: string }>).map((row) => row.name);
    subcategoriesByCategory = subcategories;
    supplierSuggestions = Array.from(
      new Set(
        [...orders.map((order) => order.supplier_name), ...((documentSuppliers ?? []) as Array<{ supplier_name: string | null }>).map((row) => row.supplier_name ?? "")]
          .map((name) => name.trim())
          .filter(Boolean)
      )
    ).slice(0, 50);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <ProductTabs />
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>공급처 발주서</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          공급처에 발주한 품목과 수량(예: 소 등심 1++ 국내산 50kg)을 적어 둡니다. 화면에서 바로 적거나, 엑셀 양식을
          내려받아 채워 올리면 됩니다. 물건이 도착했을 때 이 발주서와 맞춰 보는 기능은 다음 단계에서 붙입니다.
        </p>
      </header>

      <PurchaseOrderView
        canManage={canManage}
        categories={categories}
        subcategoriesByCategory={subcategoriesByCategory}
        supplierSuggestions={supplierSuggestions}
        orders={orders}
      />
    </div>
  );
}
