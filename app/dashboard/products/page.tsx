import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { DEMO_PRODUCTS } from "@/lib/demo/supplier-samples";
import { DEFAULT_DELIVERY_ITEMS } from "@/lib/products/default-delivery-items";
import { ProductTable } from "./product-table";
import { SeedDefaultProductsButton } from "./seed-default-products-button";
import type { Product } from "@/types/database";

export const metadata = {
  title: "상품 관리 | 도매업체 통합관리시스템",
};

export default async function DashboardProductsPage() {
  const scope = await getSupplierScope();

  let products: Product[] = [];
  let isDemoData = true;

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("products")
      .select("*")
      .eq("wholesaler_id", scope.wholesalerId)
      .order("created_at", { ascending: false });

    if (data && data.length > 0) {
      products = data as Product[];
      isDemoData = false;
    }
  }

  if (isDemoData) {
    products = DEMO_PRODUCTS;
  }

  const secretDealCount = products.filter((product) => product.is_secret_deal).length;
  const lowStockCount = products.filter((product) => Number(product.stock_quantity) <= 3).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a" }}>상품 관리</h1>
          <p style={{ fontSize: "13px", color: "#64748b", marginTop: "4px" }}>
            미니샵에 노출되는 육류 품목, 기본 단가, 재고 및 시크릿 딜 여부를 관리합니다.
          </p>
        </div>

        <Link
          href="/dashboard/products/new"
          style={{
            backgroundColor: "#dc2626",
            color: "#ffffff",
            fontSize: "13px",
            fontWeight: 700,
            padding: "10px 16px",
            borderRadius: "8px",
            whiteSpace: "nowrap",
          }}
        >
          + 신규 상품 등록
        </Link>
      </header>

      {isDemoData && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "12px 16px",
            borderRadius: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <span>
            ℹ️ 등록된 상품이 없거나 미인증(데모) 상태여서 샘플 상품을 표시하고 있습니다. 샘플 행의
            저장/삭제는 동작하지 않습니다. 아래 버튼으로 기본 납품 품목을 실제 상품으로 한 번에
            등록하면 미니샵에 바로 노출됩니다.
          </span>

          <SeedDefaultProductsButton
            disabled={!scope?.wholesalerId}
            itemCount={DEFAULT_DELIVERY_ITEMS.length}
          />
        </div>
      )}

      <section className="dash-cards">
        {[
          { label: "전체 상품", value: `${products.length}개`, accent: "#0f172a" },
          { label: "시크릿 딜", value: `${secretDealCount}개`, accent: "#b91c1c" },
          { label: "재고 부족 (3 이하)", value: `${lowStockCount}개`, accent: "#ea580c" },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "12px",
              padding: "14px 16px",
            }}
          >
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>{card.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 800, color: card.accent, marginTop: "4px" }}>
              {card.value}
            </div>
          </div>
        ))}
      </section>

      <ProductTable products={products} readOnly={isDemoData} />
    </div>
  );
}
