import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope, isSuperAdminWithoutScope } from "@/lib/supplier/scope";
import { AdminScopeNotice } from "@/components/admin-scope-notice";
import { DEFAULT_DELIVERY_ITEMS } from "@/lib/products/default-delivery-items";
import { ProductTable, type StockSummary } from "./product-table";
import { getLatestMarketPricesAction } from "@/app/actions/market-price";
import { buildMarketPriceIndex, findMarketPrice, type MarketPriceIndex } from "@/lib/market-price/product-match";
import { PriceBulkPanel } from "./price-bulk-panel";
import type { PriceCsvProduct } from "@/lib/products/price-import";

import { SeedDefaultProductsButton } from "./seed-default-products-button";
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

    products = (data ?? []) as Product[];

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

  const unpricedProducts: PriceCsvProduct[] = products
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

  // 재고 0으로 자동 발주정지된 상품 — 핫딜/일반 공통(2026-09-24 확장). 재입고돼도
  // 자동으로 안 풀리므로 여기서 인앱 배너로만 알린다. 외부 발송 채널(알림톡/SMS)은 아직 없다.
  const autoStoppedProducts = products.filter(
    (product) =>
      !product.archived_at && product.order_stopped && product.order_stopped_reason === "out_of_stock"
  );

  // 핫딜 판매 한도(있는 상품만) — 한도 도달 시 카탈로그가 자동으로 기본가로 돌아가고
  // (products 테이블은 안 건드림), 도달 임박(80% 이상) 시에도 미리 알린다. 둘 다
  // 동시 확정 경쟁으로 인한 "모르는 새 한도 넘김"을 막기 위한 사전 알림(사장님 요청).
  const quotaLimitedHotDeals = products.filter(
    (product) =>
      !product.archived_at && product.hot_deal_active && product.hot_deal_quantity_limit !== null
  );
  const quotaReachedHotDeals = quotaLimitedHotDeals.filter(
    (product) => Number(product.hot_deal_quantity_sold) >= Number(product.hot_deal_quantity_limit)
  );
  const quotaNearingHotDeals = quotaLimitedHotDeals.filter((product) => {
    const sold = Number(product.hot_deal_quantity_sold);
    const limit = Number(product.hot_deal_quantity_limit);
    const remaining = limit - sold;
    // 공급사가 상품별로 "남은 수량이 이 아래면 알림" 기준을 직접 정할 수 있다.
    // 비워뒀으면 한도의 20%가 남았을 때를 기본값으로 쓴다.
    const alertThreshold =
      product.hot_deal_quota_alert_threshold !== null
        ? Number(product.hot_deal_quota_alert_threshold)
        : limit * 0.2;
    return sold < limit && remaining <= alertThreshold;
  });

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
            미니샵에 노출되는 육류 품목, 기본 단가, 재고를 관리합니다. 핫딜은 상품 수정 화면에서, 맞춤단가는 맞춤단가관리에서 설정합니다.
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

      {quotaReachedHotDeals.length > 0 && (
        <div
          style={{
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "8px",
            padding: "12px 16px",
            fontSize: "13px",
            color: "#991b1b",
          }}
        >
          🔥 핫딜 매진 — 상품 {quotaReachedHotDeals.length}개가 한도만큼 다 팔려 기본 단가로 자동 전환됐습니다(일반
          매장에서 계속 판매 중). 핫딜을 완전히 끝내려면 상품 수정 화면에서 핫딜 토글을 직접 꺼주세요.
          <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
            {quotaReachedHotDeals.map((product) => (
              <li key={product.id}>
                <Link href={`/dashboard/products/${product.id}/edit`} style={{ color: "#991b1b", fontWeight: 700 }}>
                  {product.name}
                </Link>{" "}
                ({Number(product.hot_deal_quantity_sold).toLocaleString("ko-KR")}/
                {Number(product.hot_deal_quantity_limit).toLocaleString("ko-KR")}
                {product.unit})
              </li>
            ))}
          </ul>
        </div>
      )}

      {quotaNearingHotDeals.length > 0 && (
        <div
          style={{
            backgroundColor: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "8px",
            padding: "12px 16px",
            fontSize: "13px",
            color: "#92400e",
          }}
        >
          ⏳ 핫딜 매진 임박 — 상품 {quotaNearingHotDeals.length}개가 설정하신 임박 기준에 닿았습니다. 곧 매진되어
          기본 단가로 자동 전환됩니다 — 한도를 늘리고 싶으면 미리 조정해주세요.
          <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
            {quotaNearingHotDeals.map((product) => (
              <li key={product.id}>
                <Link href={`/dashboard/products/${product.id}/edit`} style={{ color: "#92400e", fontWeight: 700 }}>
                  {product.name}
                </Link>{" "}
                ({Number(product.hot_deal_quantity_sold).toLocaleString("ko-KR")}/
                {Number(product.hot_deal_quantity_limit).toLocaleString("ko-KR")}
                {product.unit})
              </li>
            ))}
          </ul>
        </div>
      )}

      {autoStoppedProducts.length > 0 && (
        <div
          style={{
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "8px",
            padding: "12px 16px",
            fontSize: "13px",
            color: "#991b1b",
          }}
        >
          ⛔ 상품 {autoStoppedProducts.length}개가 재고 0으로 발주가 자동정지됐습니다. 재입고해도 자동으로
          다시 열리지 않으니, 상품 수정 화면에서 확인 후 직접 재개해주세요.
          <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
            {autoStoppedProducts.map((product) => (
              <li key={product.id}>
                <Link href={`/dashboard/products/${product.id}/edit`} style={{ color: "#991b1b", fontWeight: 700 }}>
                  {product.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scope?.wholesalerId && products.length === 0 && (
        <div
          style={{
            backgroundColor: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "8px",
            padding: "12px 16px",
            fontSize: "13px",
            color: "#334155",
          }}
        >
          아직 등록된 상품이 없습니다. 아래 버튼으로 기본 납품 품목을 한 번에 불러올 수 있습니다.
          <div style={{ marginTop: "10px" }}>
            <SeedDefaultProductsButton itemCount={DEFAULT_DELIVERY_ITEMS.length} />
          </div>
        </div>
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
        memberNames={memberNames}
        stockSummaries={stockSummaries}
        marketPrices={marketPrices}
      />
    </div>
  );
}
