import { createClient } from "@/lib/supabase/server";
import { ProductForm } from "./product-form";
import { ProductList } from "./product-list";
import type { Product } from "@/types/database";

export default async function WholesalerProductsPage() {
  const supabase = await createClient();

  // Supabase Auth 세션 확인
  const { data: { user } } = await supabase.auth.getUser();

  let products: Product[] = [];
  let wholesalerName = "도매상점";
  let shopToken: string | null = null;
  let isNotAuthenticated = false;

  if (!user) {
    isNotAuthenticated = true;
  } else {
    // 도매업자 정보 조회
    const { data: wholesaler } = await supabase
      .from("wholesalers")
      .select("id, business_name, shop_token")
      .eq("profile_id", user.id)
      .single();

    if (wholesaler) {
      wholesalerName = wholesaler.business_name;
      shopToken = wholesaler.shop_token;

      // 본인 소유 상품 목록 조회
      const { data } = await supabase
        .from("products")
        .select("*")
        .eq("wholesaler_id", wholesaler.id)
        .order("created_at", { ascending: false });

      if (data) {
        products = data as Product[];
      }
    }
  }

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "8px" }}>
          <div>
            <span style={{ fontSize: "12px", color: "#dc2626", fontWeight: 700 }}>도매 관리자 모드</span>
            <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a" }}>{wholesalerName} 상품 관리</h1>
          </div>
          {shopToken && (
            <a
              href={`/shop/${shopToken}`}
              target="_blank"
              style={{
                fontSize: "12px",
                color: "#2563eb",
                fontWeight: 600,
                textDecoration: "underline",
              }}
            >
              내 미니샵 바로가기 ↗
            </a>
          )}
        </div>
        <p style={{ fontSize: "13px", color: "#64748b" }}>
          단골 식당에 노출될 육류 품목, 기준 단가, 실시간 재고 및 시크릿 딜을 관리합니다.
        </p>
      </header>

      {isNotAuthenticated && (
        <div style={{ backgroundColor: "#fef3c7", border: "1px solid #fde68a", padding: "12px 16px", borderRadius: "8px", marginBottom: "20px", fontSize: "13px", color: "#92400e" }}>
          ⚠️ 현재 Supabase Auth 로그인이 되어있지 않은 데모/개발 모드 상태입니다. 실제 DB 연동 시 도매업자 로그인 세션으로 보호됩니다.
        </div>
      )}

      {/* 신규 상품 등록 컴포넌트 */}
      <ProductForm />

      {/* 등록된 상품 목록 컴포넌트 */}
      <section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#1e293b" }}>
            등록된 상품 ({products.length})
          </h2>
        </div>
        <ProductList products={products} />
      </section>
    </main>
  );
}
