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
  /** 맞춤 단가가 있으면 맞춤 단가, 없으면 기준 단가 */
  effectivePrice: number;
  isCustomPrice: boolean;
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
}

export interface ShopCatalog {
  shopToken: string;
  wholesaler: Wholesaler;
  items: ShopCatalogItem[];
  customer: ShopCustomer;
  /** 시크릿 딜 열람 권한 */
  canViewSecretDeals: boolean;
  /** Supabase 미설정/미등록 상태의 시연 데이터 여부 */
  isDemo: boolean;
}

export interface CartEntryInput {
  productId: string;
  quantity: number;
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

    lines.push({
      productId: item.product.id,
      name: item.product.name,
      unit: item.product.unit,
      unitPrice: item.effectivePrice,
      basePrice: Number(item.product.base_price),
      quantity,
      stockQuantity: Number(item.product.stock_quantity),
      isCustomPrice: item.isCustomPrice,
      isSecretDeal: item.product.is_secret_deal,
    });

    return lines;
  }, []);
}
