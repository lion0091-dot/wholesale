import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { DEMO_PRODUCTS } from "@/lib/demo/supplier-samples";
import { DEFAULT_DELIVERY_ITEMS } from "@/lib/products/default-delivery-items";
import { ProductTable, type StockSummary } from "./product-table";
import { getLatestMarketPricesAction } from "@/app/actions/market-price";
import { buildMarketPriceIndex, findMarketPrice, type MarketPriceIndex } from "@/lib/market-price/product-match";
import { PriceBulkPanel } from "./price-bulk-panel";
import type { PriceCsvProduct } from "@/lib/products/price-import";

import { SeedDefaultProductsButton } from "./seed-default-products-button";
import { DemoNoticeBanner } from "./demo-notice-banner";
import type { Product } from "@/types/database";

export const metadata = {
  title: "상품 관리 | 도매업체 통합관리시스템",
};

export default async function DashboardProductsPage() {
  const scope = await getSupplierScope();

  if (isSuperAdminWithoutScope(scope)) {
    return <AdminScopeNotice />;
  }

  let products: Product[] = [];
  let isDemoData = true;
  let memberNames: Record<string, string> = {};
  // 상품별 재고 신선도 요약(도축일/포장일/박스수). 목록에서 상품마다 따로 조회하면
  // N+1이 되므로 한 번에 집계해 받아 상품 id로 매핑한다.
  let stockSummaries: Record<string, StockSummary> = {};
  // 상품마다 시세를 따로 조회하면 N+1이라, 최신 스냅샷을 한 번만 읽어 맵으로 만든다.
  // 고객 계정에서는 RLS가 0건을 돌려주므로 여기서 별도 권한 체크가 필요 없다.
  let marketPrices: MarketPriceIndex = new Map();

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const [{ data }, { data: members }, { data: summaries }] = await Promise.all([
      supabase
        .from("products")
        .select("*")
        .eq("wholesaler_id", scope.wholesalerId)
        // created_at만으로는 기본 납품 품목 일괄 등록처럼 한 트랜잭션에서 여러 행을
        // 동시에 넣으면 값이 전부 같아져서 동률이 생긴다 — 동률 사이 순서가 요청마다
        // 달라지면 화면상 같은 위치의 행이 새로고침할 때마다 다른 상품으로 바뀌어
        // 보이는 문제가 생긴다(토글을 두 번 누르면 엉뚱한 상품이 바뀌는 것처럼 보임).
        // id를 2차 정렬 키로 둬서 순서를 항상 동일하게 고정한다.
        .order("created_at", { ascending: false })
        .order("id", { ascending: true }),
      supabase.rpc("list_wholesaler_member_names", { p_wholesaler_id: scope.wholesalerId }),
      supabase.rpc("get_product_stock_summary", { p_wholesaler_id: scope.wholesalerId }),
    ]);

    if (data && data.length > 0) {
      products = data as Product[];
      isDemoData = false;
    }

    stockSummaries = Object.fromEntries(
      ((summaries ?? []) as StockSummary[]).map((summary) => [summary.product_id, summary])
    );

    const marketPriceResult = await getLatestMarketPricesAction();

    if (marketPriceResult.success) {
      marketPrices = buildMarketPriceIndex(marketPriceResult.data ?? []);
    }

    memberNames = Object.fromEntries(
      ((members ?? []) as Array<{ user_id: string; name: string | null }>).map((member) => [
        member.user_id,
        member.name || "이름 미등록",
      ])
    );
  }

  if (isDemoData) {
    products = DEMO_PRODUCTS;
  }

  const unpricedProducts: PriceCsvProduct[] = isDemoData
    ? []
    : products
        .filter((product) => !product.archived_at && Number(product.base_price) <= 0)
        .map((product) => ({
          id: product.id,
          name: product.name,
          category: product.category,
          subcategory: product.subcategory,
          grade: product.grade,
          unit: product.unit,
          basePrice: Number(product.base_price),
          marketPrice:
            findMarketPrice(marketPrices, product.category, product.grade)?.pricePerKg ?? null,
        }));

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
            미니샵에 노출되는 육류 품목, 기본 단가, 재고를 관리합니다. 맞춤단가·핫딜은 맞춤단가관리에서 설정합니다.
          </p>
        </div>

        <Link
          href="/dashboard/products/new"
          style={{
            backgroundColor: "#0f172a",
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
        <DemoNoticeBanner>
          <SeedDefaultProductsButton
            disabled={!scope?.wholesalerId}
            itemCount={DEFAULT_DELIVERY_ITEMS.length}
          />
        </DemoNoticeBanner>
      )}

      <section className="dash-cards">
        {[
          { label: "전체 상품", value: `${products.length}개`, accent: "#0f172a" },
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

      {/* 스캔으로 자동 등록된 상품은 판매가가 0원이라 고객에게 안 보인다 —
          수십 개를 하나씩 고치지 않게 CSV로 내려받아 채워 올리는 경로를 둔다. */}
      <PriceBulkPanel unpricedProducts={unpricedProducts} />

      <ProductTable
        products={products}
        readOnly={isDemoData}
        memberNames={memberNames}
        stockSummaries={stockSummaries}
        marketPrices={marketPrices}
      />
    </div>
  );
}
