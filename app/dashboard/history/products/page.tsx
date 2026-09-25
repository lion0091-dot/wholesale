import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
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

  let products: Product[] = [];

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("products")
      .select("*")
      .eq("wholesaler_id", scope.wholesalerId)
      .order("name", { ascending: true });

    products = (data ?? []) as Product[];
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>
        상품을 골라 가격·단위·재고·판매상태 변경 이력을 확인합니다.
      </p>

      <HistoryPickerList
        tableName="products"
        items={products.map(toItem)}
        searchPlaceholder="상품명으로 검색"
        emptyMessage="등록된 상품이 없습니다."
      />
    </div>
  );
}
