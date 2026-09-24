/** 여러 테스트 파일이 공유하는 최소 목(mock) 픽스처. 실제 DB 스키마 필드를 전부 채워
 * 타입 체크를 통과시키되, 각 테스트는 필요한 필드만 override해서 쓴다. */
import type { Product, Wholesaler } from "@/types/database";

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "product-1",
    wholesaler_id: "wholesaler-1",
    name: "한우 등심",
    category: "소",
    subcategory: "등심",
    origin: "국내산",
    grade: "1++",
    base_price: 30000,
    unit: "kg",
    stock_quantity: 10,
    is_active: true,
    description: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    created_by: null,
    updated_by: null,
    archived_at: null,
    hot_deal_price: null,
    hot_deal_active: false,
    order_stopped: false,
    order_stopped_reason: null,
    order_stopped_at: null,
    hot_deal_quantity_limit: null,
    hot_deal_quantity_sold: 0,
    hot_deal_quota_alert_threshold: null,
    ...overrides,
  };
}

export function makeWholesaler(overrides: Partial<Wholesaler> = {}): Wholesaler {
  return {
    id: "wholesaler-1",
    profile_id: "profile-1",
    business_name: "테스트 도매상회",
    business_number: "1234567890",
    representative_name: "김도매",
    business_address: "서울특별시 송파구 도매로 45",
    business_start_date: "2020-01-01",
    nts_verification_status: "match",
    nts_verified_at: "2026-01-01T00:00:00Z",
    business_license_path: null,
    business_license_uploaded_at: null,
    shop_token: "test-shop-token",
    status: "active",
    subscription_status: "active",
    trial_started_at: "2026-01-01T00:00:00Z",
    billing_starts_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    allow_price_negotiation: false,
    min_order_amount: 50000,
    ...overrides,
  };
}
