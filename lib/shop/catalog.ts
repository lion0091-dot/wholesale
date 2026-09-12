/**
 * 고객(식당) 미니샵 카탈로그 로더.
 *
 * /shop/<shop_token> 및 하위 cart·checkout 경로가 공통으로 사용한다.
 * - 공급사(도매) 식별 및 활성 상태 확인
 * - 접속 고객(식당) 바인딩 및 거래 관계 확인
 * - 상품 목록에 해당 식당 전용 맞춤 단가 적용
 * - 시크릿 딜은 거래 관계가 확인된 단골 고객에게만 노출 (미연결 고객에게는 응답에서 제외)
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
};

function demoWholesaler(shopToken: string): Wholesaler {
  const timestamp = new Date().toISOString();

  return {
    id: "demo-wholesaler-id",
    profile_id: "demo-profile-id",
    business_name: "마장동 태양축산 (테스트 도매)",
    business_number: "123-45-67890",
    representative_name: "김태양",
    shop_token: shopToken,
    status: "active",
    subscription_status: "active",
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
  };
}

function demoCatalog(shopToken: string): ShopCatalog {
  const customer = demoCustomer();
  const customPrices = new Map(
    DEMO_CUSTOM_PRICES.filter((price) => price.retailer_id === customer.retailerId).map(
      (price) => [price.product_id, Number(price.custom_price)]
    )
  );

  const items: ShopCatalogItem[] = DEMO_PRODUCTS.map((product) => {
    const custom = customPrices.get(product.id);

    return {
      product,
      effectivePrice: custom ?? Number(product.base_price),
      isCustomPrice: custom !== undefined,
    };
  });

  return {
    shopToken,
    wholesaler: demoWholesaler(shopToken),
    items,
    customer,
    canViewSecretDeals: customer.isLinked,
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
  };
}

/** 식당 전용 맞춤 단가 조회 (retailer_id + product_id 단위) */
async function loadCustomPrices(
  supabase: SupabaseServerClient,
  retailerId: string,
  productIds: string[]
): Promise<Map<string, number>> {
  if (productIds.length === 0) {
    return new Map();
  }

  const { data } = await supabase
    .from("custom_prices")
    .select("product_id, custom_price")
    .eq("retailer_id", retailerId)
    .in("product_id", productIds);

  return new Map(
    (data ?? []).map((row) => [row.product_id as string, Number(row.custom_price)])
  );
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
      "id, profile_id, business_name, business_number, representative_name, shop_token, status, subscription_status, created_at, updated_at"
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
    .order("is_secret_deal", { ascending: true })
    .order("name", { ascending: true });

  const products = (productsData ?? []) as Product[];

  if (products.length === 0) {
    return { ...demoCatalog(shopToken), wholesaler, isDemo: true };
  }

  const customer = await resolveCustomer(supabase, wholesaler.id);
  const canViewSecretDeals = customer.isLinked;

  const visibleProducts = products.filter(
    (product) => canViewSecretDeals || !product.is_secret_deal
  );

  const customPrices = customer.retailerId
    ? await loadCustomPrices(
        supabase,
        customer.retailerId,
        visibleProducts.map((product) => product.id)
      )
    : new Map<string, number>();

  const items: ShopCatalogItem[] = visibleProducts.map((product) => {
    const custom = customPrices.get(product.id);

    return {
      product,
      effectivePrice: custom ?? Number(product.base_price),
      isCustomPrice: custom !== undefined,
    };
  });

  return {
    shopToken,
    wholesaler,
    items,
    customer,
    canViewSecretDeals,
    isDemo: false,
  };
}

export { findCatalogItem, toCartLines };
