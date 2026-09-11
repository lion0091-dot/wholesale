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
import { getCustomerSession } from "@/lib/auth/customer-token";
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
 * 1순위: 초대 링크로 발급된 고객 세션 쿠키(retailer 바인딩 완료)
 * 2순위: 로그인 사용자 → retailers 조회 (세션 쿠키 재발급 전 상태)
 * 도매(공급사) 계정은 고객으로 취급하지 않는다 (경쟁사 염탐 차단).
 */
async function resolveCustomer(
  supabase: SupabaseServerClient,
  wholesalerId: string,
  shopToken: string
): Promise<ShopCustomer> {
  const session = await getCustomerSession();
  let retailerId = session && session.shopToken === shopToken ? session.retailerId : null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, phone")
      .eq("id", user.id)
      .maybeSingle();

    if (profile?.role === "wholesaler") {
      return GUEST_CUSTOMER;
    }

    if (!retailerId) {
      const { data: retailer } = await supabase
        .from("retailers")
        .select("id")
        .eq("profile_id", user.id)
        .maybeSingle();

      retailerId = (retailer?.id as string | undefined) ?? null;
    }
  }

  if (!retailerId) {
    return GUEST_CUSTOMER;
  }

  const [{ data: retailer }, { data: relation }] = await Promise.all([
    supabase
      .from("retailers")
      .select("id, profile_id, restaurant_name, representative_name, delivery_address, delivery_address_detail")
      .eq("id", retailerId)
      .maybeSingle(),
    supabase
      .from("wholesaler_retailers")
      .select("status")
      .eq("wholesaler_id", wholesalerId)
      .eq("retailer_id", retailerId)
      .maybeSingle(),
  ]);

  if (!retailer) {
    return GUEST_CUSTOMER;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", retailer.profile_id as string)
    .maybeSingle();

  return {
    retailerId: retailer.id as string,
    restaurantName: retailer.restaurant_name as string,
    representativeName: retailer.representative_name as string,
    contactPhone: (profile?.phone as string | undefined) ?? null,
    deliveryAddress: [retailer.delivery_address, retailer.delivery_address_detail]
      .filter(Boolean)
      .join(", "),
    isLinked: relation?.status === "active",
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

  const customer = await resolveCustomer(supabase, wholesaler.id, shopToken);
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
