/**
 * 고객(식당) 미니샵 카탈로그 로더.
 *
 * /shop/<shop_token> 및 하위 cart·checkout 경로가 공통으로 사용한다.
 * - 공급사(도매) 식별 및 활성 상태 확인
 * - 접속 고객(식당) 바인딩 및 거래 관계 확인
 * - 모든 상품은 항상 전체 고객에게 기준 단가로 노출된다("숨겨진 상품" 개념 없음).
 *   그 고객에게 켜진(is_active) custom_prices 매핑이 있으면 그 가격으로 대체된다 —
 *   kind='hot_deal' 매핑이 있으면 그 가격이 최우선, 없으면 kind='custom' 매핑, 둘 다
 *   없거나 꺼져 있으면 기준 단가.
 *
 * Supabase 미설정/데이터 미존재 시 백오피스와 동일한 데모 모드 샘플로 대체한다.
 *
 * 서버 전용 모듈(next/headers 의존). 클라이언트 컴포넌트는 타입·순수 함수만 있는
 * `@/lib/shop/catalog-types`를 import 해야 한다.
 */

import { createClient } from "@/lib/supabase/server";
import { resolveBuyerIdentity } from "@/lib/auth/buyer-auth";
import {
  DEMO_CUSTOM_PRICES,
  DEMO_PRODUCTS,
  DEMO_RETAILERS,
} from "@/lib/demo/supplier-samples";
import {
  findCatalogItem,
  toCartLines,
  type ShopCatalog,
  type ShopCatalogItem,
  type ShopCustomer,
} from "@/lib/shop/catalog-types";
import type { Product, Wholesaler } from "@/types/database";

export type {
  CartEntryInput,
  ShopCatalog,
  ShopCatalogItem,
  ShopCustomer,
} from "@/lib/shop/catalog-types";

const GUEST_CUSTOMER: ShopCustomer = {
  retailerId: null,
  restaurantName: null,
  representativeName: null,
  contactPhone: null,
  deliveryAddress: null,
  isLinked: false,
  creditLimit: 0,
  allowedPaymentMethods: [],
};

function demoWholesaler(shopToken: string): Wholesaler {
  const timestamp = new Date().toISOString();

  return {
    id: "demo-wholesaler-id",
    profile_id: "demo-profile-id",
    business_name: "마장동 태양축산 (테스트 도매)",
    business_number: "123-45-67890",
    representative_name: "김태양",
    business_address: "서울 성동구 마장로 123, 2층",
    business_start_date: "2018-03-05",
    nts_verification_status: "match",
    nts_verified_at: timestamp,
    business_license_path: "demo-profile-id/business-license",
    business_license_uploaded_at: timestamp,
    shop_token: shopToken,
    status: "active",
    subscription_status: "active",
    trial_started_at: timestamp,
    billing_starts_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** 데모 모드에서는 첫 번째 샘플 식당을 단골 고객으로 간주하여 맞춤 단가 UI를 시연한다. */
function demoCustomer(): ShopCustomer {
  const retailer = DEMO_RETAILERS[0];

  return {
    retailerId: retailer.id,
    restaurantName: retailer.restaurant_name,
    representativeName: retailer.representative_name,
    contactPhone: "010-9876-5432",
    deliveryAddress: [retailer.delivery_address, retailer.delivery_address_detail]
      .filter(Boolean)
      .join(", "),
    isLinked: retailer.status === "active",
    // 데모 모드는 실제 wholesaler_retailers 행이 없으므로 외상 UI 시연용 고정값을 사용한다.
    creditLimit: 300000,
    // PG는 실제 자격정보가 없어 시연 불가 — 직접정산/외상만 시연한다.
    allowedPaymentMethods: ["prepaid", "on_credit"],
  };
}

function demoCatalog(shopToken: string): ShopCatalog {
  const customer = demoCustomer();
  const myPrices = DEMO_CUSTOM_PRICES.filter(
    (price) => price.retailer_id === customer.retailerId && price.is_active
  );
  const hotDealByProduct = new Map(
    myPrices.filter((price) => price.kind === "hot_deal").map((price) => [price.product_id, Number(price.custom_price)])
  );
  const customByProduct = new Map(
    myPrices.filter((price) => price.kind === "custom").map((price) => [price.product_id, Number(price.custom_price)])
  );

  const items: ShopCatalogItem[] = DEMO_PRODUCTS.map((product) => {
    const hotDeal = hotDealByProduct.get(product.id);
    const custom = customByProduct.get(product.id);

    return {
      product,
      effectivePrice: hotDeal ?? custom ?? Number(product.base_price),
      isCustomPrice: hotDeal === undefined && custom !== undefined,
      isHotDeal: hotDeal !== undefined,
    };
  });

  return {
    shopToken,
    wholesaler: demoWholesaler(shopToken),
    items,
    customer,
    isDemo: true,
  };
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * 접속 고객 식별.
 *
 * 신원 근거는 Supabase Auth 세션(auth.uid()) 하나뿐이다.
 * 서명 쿠키(wsale_customer_session) 기반 판정은 폐기했다 — 링크/쿠키가 유출되면
 * 타인이 그대로 대리 조작할 수 있었기 때문이다.
 * 이제 미니샵 진입 라우트가 카카오 로그인을 먼저 강제하고,
 * 거래처 매핑은 claim_shop_access() 가 확정한다.
 *
 * 도매(공급사)·관리자 계정은 고객으로 취급하지 않는다 (경쟁사 염탐 차단).
 */
async function resolveCustomer(
  supabase: SupabaseServerClient,
  wholesalerId: string
): Promise<ShopCustomer> {
  const buyer = await resolveBuyerIdentity(supabase, wholesalerId);

  if (!buyer || !buyer.retailerId) {
    return GUEST_CUSTOMER;
  }

  return {
    retailerId: buyer.retailerId,
    restaurantName: buyer.restaurantName,
    representativeName: buyer.representativeName,
    contactPhone: buyer.contactPhone,
    deliveryAddress: buyer.deliveryAddress,
    isLinked: buyer.isLinked,
    creditLimit: buyer.creditLimit,
    allowedPaymentMethods: buyer.allowedPaymentMethods,
  };
}

interface EffectivePriceMaps {
  /** product_id → 켜진 핫딜(kind='hot_deal') 단가 */
  hotDeal: Map<string, number>;
  /** product_id → 켜진 맞춤단가(kind='custom') 단가 */
  custom: Map<string, number>;
}

/** 식당 전용 맞춤단가·핫딜 조회 (kind별로 분리, is_active=true만) */
async function loadCustomPrices(
  supabase: SupabaseServerClient,
  retailerId: string,
  productIds: string[]
): Promise<EffectivePriceMaps> {
  if (productIds.length === 0) {
    return { hotDeal: new Map(), custom: new Map() };
  }

  const { data } = await supabase
    .from("custom_prices")
    .select("product_id, custom_price, kind")
    .eq("retailer_id", retailerId)
    .eq("is_active", true)
    .in("product_id", productIds);

  const hotDeal = new Map<string, number>();
  const custom = new Map<string, number>();

  for (const row of data ?? []) {
    const target = row.kind === "hot_deal" ? hotDeal : custom;
    target.set(row.product_id as string, Number(row.custom_price));
  }

  return { hotDeal, custom };
}

/**
 * 미니샵 카탈로그 조회.
 * 공급사/상품 데이터가 없으면 데모 카탈로그로 대체하므로 항상 값을 반환한다.
 */
export async function loadShopCatalog(shopToken: string): Promise<ShopCatalog> {
  const supabase = await createClient();

  const { data: wholesalerData } = await supabase
    .from("wholesalers")
    .select(
      "id, profile_id, business_name, business_number, representative_name, shop_token, status, subscription_status, created_at, updated_at, pg_client_key"
    )
    .eq("shop_token", shopToken)
    .maybeSingle();

  // 미등록/정지된 공급사 링크는 시연용 데모 카탈로그로 대체 (실 데이터 노출 없음)
  if (!wholesalerData || wholesalerData.status !== "active") {
    return demoCatalog(shopToken);
  }

  const wholesaler = wholesalerData as Wholesaler;

  const { data: productsData } = await supabase
    .from("products")
    .select("*")
    .eq("wholesaler_id", wholesaler.id)
    .eq("is_active", true)
    .order("name", { ascending: true });

  const products = (productsData ?? []) as Product[];

  if (products.length === 0) {
    return { ...demoCatalog(shopToken), wholesaler, isDemo: true };
  }

  const customer = await resolveCustomer(supabase, wholesaler.id);

  const { hotDeal, custom } = customer.retailerId
    ? await loadCustomPrices(
        supabase,
        customer.retailerId,
        products.map((product) => product.id)
      )
    : { hotDeal: new Map<string, number>(), custom: new Map<string, number>() };

  // 모든 상품은 항상 전체 고객에게 기준 단가로 노출된다. 켜진 핫딜 매핑이 있으면
  // 그 가격이 최우선, 없으면 켜진 맞춤단가 매핑, 둘 다 없으면 기준 단가.
  const items: ShopCatalogItem[] = products.map((product) => {
    const hotDealPrice = hotDeal.get(product.id);
    const customPrice = custom.get(product.id);

    return {
      product,
      effectivePrice: hotDealPrice ?? customPrice ?? Number(product.base_price),
      isCustomPrice: hotDealPrice === undefined && customPrice !== undefined,
      isHotDeal: hotDealPrice !== undefined,
    };
  });

  return {
    shopToken,
    wholesaler,
    items,
    customer,
    isDemo: false,
  };
}

export { findCatalogItem, toCartLines };
