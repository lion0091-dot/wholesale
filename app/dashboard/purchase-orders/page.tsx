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

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const [{ data: orderRows }, { data: categoryRows }, subcategories, { data: supplierRows }, productOptions] = await Promise.all([
      supabase
        .from("purchase_orders")
        .select(
          "id, supplier_id, supplier_name, ordered_on, expected_on, note, status, auto_closed_at, purchase_order_lines ( line_no, product_id, category, breed, subcategory, grade, origin, quantity, unit, unit_price, purchase_order_line_scans ( weight, inbound_scans ( status ) ) )"
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

    type RawLine = Omit<PurchaseOrderRow["purchase_order_lines"][number], "received"> & {
      purchase_order_line_scans?: Array<{ weight: number | string; inbound_scans: { status: string } | null }>;
    };

    orders = ((orderRows ?? []) as unknown as Array<Omit<PurchaseOrderRow, "purchase_order_lines"> & { purchase_order_lines: RawLine[] }>).map((order) => ({
      ...order,
      purchase_order_lines: [...(order.purchase_order_lines ?? [])]
        .sort((a, b) => a.line_no - b.line_no)
        .map(({ purchase_order_line_scans, ...line }) => ({
          ...line,
          // 받은 양 = 이 줄에 채워진 박스 무게(취소 제외)의 합 — DB 판정(judge_scan_purchase_order)과 같은 계산.
          received: (purchase_order_line_scans ?? []).reduce(
            (sum, link) => (link.inbound_scans && link.inbound_scans.status !== "VOIDED" ? sum + Number(link.weight) : sum),
            0
          ),
        })),
    }));
    categories = ((categoryRows ?? []) as Array<{ name: string }>).map((row) => row.name);
    subcategoriesByCategory = subcategories;
    products = productOptions;
    suppliers = ((supplierRows ?? []) as unknown as SupplierRow[]).map((row) => ({ ...row, aliases: row.aliases ?? [] }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", margin: 0 }}>발주 관리</h1>
        <p style={{ fontSize: "13px", color: "#64748b", margin: "6px 0 0" }}>
          공급처에 발주한 품목과 수량(예: 소 등심 1++ 국내산 50kg)을 적어 둡니다. 공급처는 아래 거래처 목록에서 고르고,
          품목은 축종부터 부위·등급·원산지까지 차례로 골라서 정합니다(이미 등록된 상품이면 자동으로 연결되고, 없으면 그 자리에서 새로 등록됩니다) — 엑셀 양식을 내려받아 채워 올려도 됩니다. 물건이 도착했을 때 이 발주서와 맞춰 보는 기능은 다음 단계에서 붙입니다.
        </p>
      </header>

      <PurchaseOrderView
        canManage={canManage}
        categories={categories}
        subcategoriesByCategory={subcategoriesByCategory}
        suppliers={suppliers}
        orders={orders}
        products={products}
      />
    </div>
  );
}
