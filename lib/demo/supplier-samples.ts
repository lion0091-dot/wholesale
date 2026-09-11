import type { Product } from "@/types/database";

/**
 * Supabase 미설정/미인증(데모 모드)에서 백오피스 UI를 시연하기 위한 샘플 데이터.
 * id는 데모 전용 문자열이므로 실제 Server Action 호출 시 검증 단계에서 거부된다.
 */
const now = () => new Date().toISOString();

export const DEMO_PRODUCTS: Product[] = [
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
    created_at: now(),
    updated_at: now(),
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
    created_at: now(),
    updated_at: now(),
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
    stock_quantity: 2,
    is_secret_deal: true,
    is_active: true,
    description: "국거리 및 육수용 당일 한정 수량 소진 특가 (단골 전용)",
    created_at: now(),
    updated_at: now(),
  },
];

export interface DemoRetailer {
  id: string;
  restaurant_name: string;
}

export const DEMO_RETAILERS: DemoRetailer[] = [
  { id: "demo-retailer-1", restaurant_name: "을지로 한우마을 (구매 회원)" },
  { id: "demo-retailer-2", restaurant_name: "성수 정육식당" },
  { id: "demo-retailer-3", restaurant_name: "마포 갈비천국" },
];

export interface DemoCustomPrice {
  id: string;
  retailer_id: string;
  product_id: string;
  custom_price: number;
  updated_at: string;
}

export const DEMO_CUSTOM_PRICES: DemoCustomPrice[] = [
  {
    id: "demo-cp-1",
    retailer_id: "demo-retailer-1",
    product_id: "sample-1",
    custom_price: 79000,
    updated_at: now(),
  },
  {
    id: "demo-cp-2",
    retailer_id: "demo-retailer-2",
    product_id: "sample-2",
    custom_price: 17800,
    updated_at: now(),
  },
];
