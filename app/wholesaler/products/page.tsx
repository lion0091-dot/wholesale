import { createClient } from "@/lib/supabase/server";
import { ProductForm } from "./product-form";
import { ProductList } from "./product-list";
import { CopyInviteButton } from "@/components/copy-invite-button";
import {
  describeInviteRestriction,
  getSupplierAccount,
} from "@/lib/supplier/verification";
import type { Product } from "@/types/database";

export default async function WholesalerProductsPage() {
  const supabase = await createClient();

  // 초대장 발부 권한 (미승인 공급사는 잠김)
  const inviteAccount = await getSupplierAccount();
  const inviteRestriction = inviteAccount ? describeInviteRestriction(inviteAccount) : "로그인 후 승인된 공급사 계정에서만 초대장을 발부할 수 있습니다.";
  const canIssueInvite = inviteAccount?.canIssueInvite ?? false;

  // Supabase Auth 세션 확인
  const { data: { user } } = await supabase.auth.getUser();

  let products: Product[] = [];
  let wholesalerName = "도매상점";
  let shopToken: string | null = null;
  let isNotAuthenticated = false;

  if (!user) {
    isNotAuthenticated = true;
    wholesalerName = "마장동 태양축산 (테스트 도매)";
    shopToken = "demo-token-12345";
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

  // 데모 상태 또는 상품이 아직 등록되지 않은 경우의 시연용 기본 상품 제공
  if (products.length === 0) {
    products = [
      {
        id: "sample-1",
        wholesaler_id: "demo-wholesaler-id",
        name: "한우 1++ 등심",
        category: "소",
        origin: "국내산",
        grade: "1++ (No.9)",
        base_price: 85000,
        unit: "kg",
        stock_quantity: 12.5,
        is_secret_deal: false,
        is_active: true,
        description: "최고급 마블링 냉장 숙성 등심, 진공포장 출고",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "sample-2",
        wholesaler_id: "demo-wholesaler-id",
        name: "국내산 암퇘지 삼겹살",
        category: "돼지",
        origin: "국내산",
        grade: "1등급",
        base_price: 18500,
        unit: "kg",
        stock_quantity: 45,
        is_secret_deal: false,
        is_active: true,
        description: "미추리 선별 완료, 탕박 A급 규격돈",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "sample-3",
        wholesaler_id: "demo-wholesaler-id",
        name: "[마감임박 특가] 한우 사태/양지 믹스",
        category: "소",
        origin: "국내산",
        grade: "1등급",
        base_price: 29000,
        unit: "kg",
        stock_quantity: 8,
        is_secret_deal: true,
        is_active: true,
        description: "국거리 및 육수용 당일 한정 수량 소진 특가 (단골 전용)",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
  }

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "8px", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <span style={{ fontSize: "12px", color: "#dc2626", fontWeight: 700 }}>도매 관리자 모드</span>
            <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a" }}>{wholesalerName} 상품 관리</h1>
          </div>
          <CopyInviteButton
            canIssue={canIssueInvite}
            restrictionMessage={inviteRestriction}
            shopToken={canIssueInvite ? (inviteAccount?.shopToken ?? shopToken) : null}
          />
        </div>
        <p style={{ fontSize: "13px", color: "#64748b" }}>
          바이어(구매 회원)에게 노출될 육류 품목, 기준 단가, 실시간 재고 및 시크릿 딜을 관리합니다.
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
