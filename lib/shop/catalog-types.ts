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
  /**
   * 지금 실제로 담을 수 있는 최대 수량 — 물리 재고(stock_quantity)와, 핫딜이면서
   * 판매 한도가 걸려 있으면 "한도-누적판매(남은 한도)"까지 둘 중 작은 값이다.
   * 화면의 +버튼/수량입력이 이 값을 넘지 못하게 막아 "오버 주문"이 애초에 안 만들어지게 한다
   * (최종 방어선은 여전히 서버의 reserve_hot_deal_quota RPC).
   */
  orderableQuantity: number;
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
  /** 비활성(승인 대기·정지 등) 공급사 미니샵을 미리보기로 연 경우의 업체 상태. 일반 조회에서는 없다. */
  previewStatus?: string | null;
  /** 미리보기를 연 사람 — 슈퍼관리자 또는 그 공급사 본인(대표·직원) */
  previewViewer?: "admin" | "supplier" | null;
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
  // 핫딜 판매 한도(2026-09-24 도입) — 한도가 있고 누적 판매량이 닿으면, hot_deal_active를
  // 끄지 않아도(관리자가 직접 꺼야 완전 종료) 그 순간부터 카탈로그는 기본가로 되돌아가
  // 일반 매장에서 자동으로 계속 판매된다.
  const quotaReached =
    product.hot_deal_quantity_limit !== null &&
    Number(product.hot_deal_quantity_sold) >= Number(product.hot_deal_quantity_limit);
  const hotDealActive = Boolean(product.hot_deal_active) && product.hot_deal_price !== null && !quotaReached;

  const stockQuantity = Number(product.stock_quantity);
  // 핫딜 한도가 걸려 있으면 "남은 한도"도 상한이다 — 예: 재고 48kg 남았어도 한도가
  // 2kg만 남았으면 2kg까지만 담을 수 있어야 나중에 서버가 거부할 오버 주문 자체가
  // 화면에서 안 만들어진다.
  const hotDealRemaining =
    hotDealActive && product.hot_deal_quantity_limit !== null
      ? Math.max(0, Number(product.hot_deal_quantity_limit) - Number(product.hot_deal_quantity_sold))
      : null;
  const orderableQuantity = hotDealRemaining !== null ? Math.min(stockQuantity, hotDealRemaining) : stockQuantity;

  return {
    product,
    effectivePrice: hotDealActive
      ? Number(product.hot_deal_price)
      : customPrice ?? Number(product.base_price),
    isCustomPrice: !hotDealActive && customPrice !== undefined,
    isHotDeal: hotDealActive,
    orderableQuantity,
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

    // 발주정지된 상품은 재고가 남아 있어도(수동 정지) 담을 수 없다 — 품절과 동일하게
    // 장바구니/체크아웃에서 조용히 제외한다(클라이언트는 버튼을 미리 막지만, 최종
    // 판단은 항상 서버 카탈로그 기준).
    if (item.product.order_stopped) {
      return lines;
    }

    const quantity = normalizeQuantity(Number(entry.quantity), item.product.unit, item.orderableQuantity);

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
      // 핫딜 한도로 상한이 걸린 경우 CartLine.stockQuantity도 그 상한을 그대로 쓴다 —
      // 장바구니/체크아웃 화면의 +버튼·재고 표시·검증 문구가 전부 이 값 하나로 일관되게 맞는다.
      stockQuantity: item.orderableQuantity,
      isCustomPrice: item.isCustomPrice,
      isHotDeal: item.isHotDeal,
      requestedUnitPrice,
    });

    return lines;
  }, []);
}
