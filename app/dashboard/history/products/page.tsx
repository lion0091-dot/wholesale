import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { DEMO_PRODUCTS } from "@/lib/demo/supplier-samples";
import { HistoryPickerList, type HistoryPickerItem } from "../history-picker-list";
import type { Product } from "@/types/database";

export const metadata = {
  title: "상품 이력 | 도매업체 통합관리시스템",
};

function toItem(product: Pick<Product, "id" | "name" | "category" | "subcategory" | "origin">): HistoryPickerItem {
  return {
    id: product.id,
    title: product.name,
    subtitle: `${product.category}${product.subcategory ? ` · ${product.subcategory}` : ""} · ${product.origin}`,
  };
}

export default async function ProductHistoryPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let products: Product[] = DEMO_PRODUCTS;

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("products")
      .select("*")
      .eq("wholesaler_id", scope.wholesalerId)
      .order("name", { ascending: true });

    if (data && data.length > 0) {
      products = data as Product[];
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header>
        <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>상품 이력</h1>
        <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
          상품을 골라 가격·단위·재고·판매상태 변경 이력을 확인합니다.
        </p>
      </header>

      <HistoryPickerList
        tableName="products"
        items={products.map(toItem)}
        searchPlaceholder="상품명으로 검색"
        emptyMessage="등록된 상품이 없습니다."
      />
    </div>
  );
}
