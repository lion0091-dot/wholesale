import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { OrderList, type OrderWithDetails } from "./order-list";

export default async function WholesalerOrdersPage() {
  const supabase = await createClient();

  // Supabase Auth 세션 확인
  const { data: { user } } = await supabase.auth.getUser();

  let orders: OrderWithDetails[] = [];
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

      // 해당 도매업자에게 들어온 발주서 목록 조회
      const { data: ordersData } = await supabase
        .from("orders")
        .select(`
          *,
          order_items (*)
        `)
        .eq("wholesaler_id", wholesaler.id)
        .order("ordered_at", { ascending: false });

      if (ordersData && ordersData.length > 0) {
        orders = ordersData.map((o: any) => ({
          ...o,
          items: o.order_items || [],
        }));
      }
    }
  }

  // DB에 저장된 발주서가 없거나 데모 모드일 때의 샘플 발주서 데이터
  if (orders.length === 0) {
    orders = [
      {
        id: "demo-order-1",
        wholesaler_id: "demo-wholesaler-id",
        retailer_id: "demo-retailer-1",
        retailer_name: "을지로 한우마을 (구매 회원)",
        order_number: "ORD-20260909-A79B2C",
        total_amount: 255000,
        status: "pending",
        delivery_address: "서울 중구 을지로 123길 45, 1층 주방",
        delivery_notes: "내일 오전 6시 전까지 주방 뒷문 보냉박스에 넣어주세요.",
        ordered_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(), // 30분 전
        updated_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        items: [
          {
            id: "demo-item-1",
            order_id: "demo-order-1",
            product_id: "sample-1",
            product_name: "한우 1++ 등심",
            unit_price: 85000,
            quantity: 2,
            subtotal_amount: 170000,
            created_at: new Date().toISOString(),
          },
          {
            id: "demo-item-2",
            order_id: "demo-order-1",
            product_id: "sample-3",
            product_name: "[마감임박 특가] 한우 사태/양지 믹스",
            unit_price: 29000,
            quantity: 2,
            subtotal_amount: 58000,
            created_at: new Date().toISOString(),
          },
          {
            id: "demo-item-3",
            order_id: "demo-order-1",
            product_id: "sample-2",
            product_name: "국내산 암퇘지 삼겹살",
            unit_price: 18500,
            quantity: 1.5,
            subtotal_amount: 27000,
            created_at: new Date().toISOString(),
          },
        ],
      },
      {
        id: "demo-order-2",
        wholesaler_id: "demo-wholesaler-id",
        retailer_id: "demo-retailer-2",
        retailer_name: "성수 정육식당",
        order_number: "ORD-20260909-E54D1F",
        total_amount: 185000,
        status: "confirmed",
        delivery_address: "서울 성동구 성수일로 89, 지하 1층",
        delivery_notes: "세금계산서 발행 완료 부탁드립니다.",
        ordered_at: new Date(Date.now() - 1000 * 60 * 180).toISOString(), // 3시간 전
        updated_at: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
        items: [
          {
            id: "demo-item-4",
            order_id: "demo-order-2",
            product_id: "sample-2",
            product_name: "국내산 암퇘지 삼겹살",
            unit_price: 18500,
            quantity: 10,
            subtotal_amount: 185000,
            created_at: new Date().toISOString(),
          },
        ],
      },
    ];
  }

  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "24px 16px" }}>
      <header style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "8px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "12px", color: "#dc2626", fontWeight: 700 }}>도매 관리자 모드</span>
              <Link
                href="/wholesaler/products"
                style={{ fontSize: "12px", color: "#64748b", textDecoration: "underline" }}
              >
                ← 상품 관리로 이동
              </Link>
            </div>
            <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", marginTop: "4px" }}>
              {wholesalerName} 발주 접수 관리
            </h1>
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
          바이어(구매 회원)로부터 접수된 모바일 발주서를 실시간으로 확인하고 출고 및 배송 상태를 처리합니다.
        </p>
      </header>

      {isNotAuthenticated && (
        <div style={{ backgroundColor: "#fef3c7", border: "1px solid #fde68a", padding: "12px 16px", borderRadius: "8px", marginBottom: "20px", fontSize: "13px", color: "#92400e" }}>
          ℹ️ 현재 Supabase Auth 로그인이 되어있지 않은 데모/개발 모드 상태입니다. 샘플 발주서 및 미니샵 연동 테스트가 가능합니다.
        </div>
      )}

      {/* 발주 목록 컴포넌트 */}
      <OrderList initialOrders={orders} />
    </main>
  );
}
