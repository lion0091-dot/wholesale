/**
 * 미니샵 카탈로그의 타입과 순수 함수.
 *
 * 서버 전용 의존성(next/headers, Supabase 서버 클라이언트)을 포함하지 않으므로
 * 클라이언트 컴포넌트에서도 안전하게 import 할 수 있다.
 * 실제 데이터 로딩은 서버 전용 모듈 `@/lib/shop/catalog`이 담당한다.
 */

import { normalizeQuantity, type CartLine } from "@/lib/shop/order-policy";
import type { Product, Wholesaler } from "@/types/database";

export interface ShopCatalogItem {
  product: Product;
  /** 핫딜(상품 전체 공개) > 켜진 맞춤 단가 > 기준 단가 순으로 결정된 실제 가격 */
  effectivePrice: number;
  /** 켜진 맞춤단가 매핑이 적용됐는지 — 핫딜이 적용된 경우엔 false */
  isCustomPrice: boolean;
  /** 상품의 hot_deal_active가 켜져 있어 모든 고객에게 공개 할인가로 보이는 상태인지 */
  isHotDeal: boolean;
}

export interface ShopCustomer {
  retailerId: string | null;
  restaurantName: string | null;
  representativeName: string | null;
  contactPhone: string | null;
  deliveryAddress: string | null;
  /** 공급사와 활성 거래 관계(단골)가 확인된 고객 여부 */
  isLinked: boolean;
  /** 여신 한도 (0이면 외상 거래 불가) */
  creditLimit: number;
  /** 공급사가 이 거래처에 열어준 결제수단('prepaid'/'on_credit'/'pg') */
  allowedPaymentMethods: string[];
}

export interface ShopCatalog {
  shopToken: string;
  wholesaler: Wholesaler;
  items: ShopCatalogItem[];
  customer: ShopCustomer;
}

export interface CartEntryInput {
  productId: string;
  quantity: number;
  /** 고객이 제안하는 희망 단가 (네고 켜진 공급사만 의미 있음). */
  requestedUnitPrice?: number | null;
}

/**
 * 상품 하나의 실제 노출가/가격상태를 결정한다.
 * 핫딜(상품 자체 속성, 전체 공개) > 켜진 맞춤 단가 > 기준 단가 순으로 우선한다.
 */
export function resolveCatalogItem(
  product: Product,
  customPrice: number | undefined
): ShopCatalogItem {
  const hotDealActive = Boolean(product.hot_deal_active) && product.hot_deal_price !== null;

  return {
    product,
    effectivePrice: hotDealActive
      ? Number(product.hot_deal_price)
      : customPrice ?? Number(product.base_price),
    isCustomPrice: !hotDealActive && customPrice !== undefined,
    isHotDeal: hotDealActive,
  };
}

export function findCatalogItem(
  catalog: ShopCatalog,
  productId: string
): ShopCatalogItem | undefined {
  return catalog.items.find((item) => item.product.id === productId);
}

/**
 * 장바구니 엔트리(상품ID + 수량)를 카탈로그 기준 단가로 환산한다.
 * 단가는 항상 서버 카탈로그에서 다시 해석하므로 클라이언트가 보낸 금액은 신뢰하지 않는다.
 */
export function toCartLines(catalog: ShopCatalog, entries: CartEntryInput[]): CartLine[] {
  return entries.reduce<CartLine[]>((lines, entry) => {
    const item = findCatalogItem(catalog, entry.productId);

    if (!item) {
      return lines;
    }

    const quantity = normalizeQuantity(
      Number(entry.quantity),
      item.product.unit,
      Number(item.product.stock_quantity)
    );

    if (quantity <= 0) {
      return lines;
    }

    // 공급사가 네고를 꺼둔 경우 클라이언트가 억지로 실어 보내도 서버에서 무시한다 —
    // UI를 숨기는 것만으로는 부족하다(설정은 항상 서버 기준이 최종 권한).
    const requestedUnitPrice =
      catalog.wholesaler.allow_price_negotiation &&
      Number.isFinite(entry.requestedUnitPrice) &&
      Number(entry.requestedUnitPrice) > 0
        ? Number(entry.requestedUnitPrice)
        : null;

    lines.push({
      productId: item.product.id,
      name: item.product.name,
      category: item.product.category,
      subcategory: item.product.subcategory,
      unit: item.product.unit,
      unitPrice: item.effectivePrice,
      basePrice: Number(item.product.base_price),
      quantity,
      stockQuantity: Number(item.product.stock_quantity),
      isCustomPrice: item.isCustomPrice,
      isHotDeal: item.isHotDeal,
      requestedUnitPrice,
    });

    return lines;
  }, []);
}
