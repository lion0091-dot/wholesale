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
 * 등록되지 않았거나 정지된 공급사 링크는 notFound()로 처리한다.
 *
 * 서버 전용 모듈(next/headers 의존). 클라이언트 컴포넌트는 타입·순수 함수만 있는
 * `@/lib/shop/catalog-types`를 import 해야 한다.
 */

import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveBuyerIdentity } from "@/lib/auth/buyer-auth";
import {
  findCatalogItem,
  resolveCatalogItem,
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
 * loadShopCatalog()가 내부에서 던지는 notFound()를 Server Action의 try/catch가
 * 그대로 삼켜버리면, 고객에게 "이 페이지를 찾을 수 없습니다" 대신 Next.js 내부
 * digest 문자열이 그대로 노출된다(2026-09-23 발견). 액션 쪽 catch 블록은 이 함수로
 * 그 경우만 먼저 걸러내 알아볼 수 있는 안내문으로 바꿔야 한다 — page.tsx 쪽 호출은
 * try/catch로 감싸지 않으므로 notFound()가 원래대로 정상 동작한다(수정 불필요).
 */
export function isShopNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")
  );
}

/**
 * 미니샵 카탈로그 조회.
 * 등록되지 않았거나 정지된 공급사 링크는 404로 처리한다. 상품이 아직 없는 경우는
 * 빈 카탈로그를 반환하며, 화면(ShopView)이 "아직 등록된 품목이 없습니다"를 보여준다.
 */
export async function loadShopCatalog(shopToken: string): Promise<ShopCatalog> {
  const supabase = await createClient();

  const { data: wholesalerData } = await supabase
    .from("wholesalers")
    .select(
      "id, profile_id, business_name, business_number, representative_name, shop_token, status, subscription_status, created_at, updated_at, pg_client_key, allow_price_negotiation"
    )
    .eq("shop_token", shopToken)
    .maybeSingle();

  if (!wholesalerData || wholesalerData.status !== "active") {
    notFound();
  }

  const wholesaler = wholesalerData as Wholesaler;

  const { data: productsData } = await supabase
    .from("products")
    .select("*")
    .eq("wholesaler_id", wholesaler.id)
    .eq("is_active", true)
    // 판매가를 아직 안 정한 상품(0원)은 고객에게 내보내지 않는다. RLS 정책에도
    // 같은 조건이 있지만(20260930000058), 공급사 본인이 자기 미니샵을 열어보는
    // 경우엔 RLS의 "소유자" 분기를 타서 통과하므로 여기서도 한 번 더 거른다.
    .gt("base_price", 0)
    .order("name", { ascending: true });

  const products = (productsData ?? []) as Product[];

  const customer = await resolveCustomer(supabase, wholesaler.id);

  // isLinked가 아니면(거래중지 등) retailerId가 있어도 핫딜/맞춤단가를 계산하지 않는다 —
  // 그렇지 않으면 정지된 고객에게 여전히 핫딜 가격·배지가 노출된다.
  const { hotDeal, custom } = customer.isLinked && customer.retailerId
    ? await loadCustomPrices(
        supabase,
        customer.retailerId,
        products.map((product) => product.id)
      )
    : { hotDeal: new Map<string, number>(), custom: new Map<string, number>() };

  // 모든 상품은 항상 전체 고객에게 기준 단가로 노출된다. 켜진 핫딜 매핑이 있으면
  // 그 가격이 최우선, 없으면 켜진 맞춤단가 매핑, 둘 다 없으면 기준 단가.
  const items: ShopCatalogItem[] = products.map((product) =>
    resolveCatalogItem(product, hotDeal.get(product.id), custom.get(product.id))
  );

  return {
    shopToken,
    wholesaler,
    items,
    customer,
  };
}

export { findCatalogItem, toCartLines };
