import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ShopView } from "./shop-view";
import type { Product, Wholesaler } from "@/types/database";

interface PageProps {
  params: Promise<{
    shop_token: string;
  }>;
}

export default async function MiniShopPage({ params }: PageProps) {
  const { shop_token } = await params;
  const supabase = await createClient();

  // 1. shop_token에 해당하는 활성 도매업자 조회
  const { data: wholesalerData } = await supabase
    .from("wholesalers")
    .select("id, business_name, business_number, representative_name, shop_token, status, subscription_status")
    .eq("shop_token", shop_token)
    .single();

  // 도매업자 정보가 없으면 기본 Mock/Fallback 제공 (실제 DB 연결 전 또는 데모 테스트용)
  const wholesaler: Wholesaler = (wholesalerData as Wholesaler) || {
    id: "demo-wholesaler-id",
    profile_id: "demo-profile-id",
    business_name: "마장동 태양축산 (테스트 도매)",
    business_number: "123-45-67890",
    representative_name: "김태양",
    shop_token: shop_token,
    status: "active",
    subscription_status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // 2. 로그인 세션 확인
  const { data: { user } } = await supabase.auth.getUser();
  const isLoggedIn = !!user;

  // 3. 상품 목록 조회 (로그인 시 전체/시크릿 포함, 비로그인 시 일반 상품 중심)
  let products: Product[] = [];
  const { data: productsData } = await supabase
    .from("products")
    .select("*")
    .eq("wholesaler_id", wholesaler.id)
    .eq("is_active", true);

  if (productsData && productsData.length > 0) {
    products = productsData as Product[];
  } else {
    // DB 데이터가 아직 없는 초기 상태용 기본 시연 상품 샘플
    products = [
      {
        id: "sample-1",
        wholesaler_id: wholesaler.id,
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
        wholesaler_id: wholesaler.id,
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
        wholesaler_id: wholesaler.id,
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
    <ShopView
      wholesaler={wholesaler}
      products={products}
      isLoggedIn={isLoggedIn}
    />
  );
}
