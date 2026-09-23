"use client";

/**
 * 미니샵 장바구니 클라이언트 스토어.
 *
 * 상품 목록 / 장바구니 / 주문서 페이지가 서로 다른 라우트이므로 localStorage에 보관한다.
 * 단가는 저장하지 않고 상품ID+수량만 보관하며, 금액은 매 페이지에서 서버 카탈로그로 재계산한다.
 * (단가 조작 방지 + 공급사가 단가를 변경했을 때 자동 반영)
 */

import { useCallback, useEffect, useState } from "react";
import { normalizeQuantity, quantityStepFor } from "@/lib/shop/order-policy";

export interface CartEntry {
  productId: string;
  quantity: number;
  /** 고객이 이번 발주에 한해 제안하는 희망 단가 (네고 켜진 공급사만). */
  requestedUnitPrice?: number;
}

const STORAGE_PREFIX = "wsale_cart:";
const CHANGE_EVENT = "wsale-cart-change";

function storageKey(shopToken: string): string {
  return `${STORAGE_PREFIX}${shopToken}`;
}

function readEntries(shopToken: string): CartEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(storageKey(shopToken));

    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((row) => {
      if (typeof row !== "object" || row === null) {
        return [];
      }

      const { productId, quantity, requestedUnitPrice } = row as Partial<CartEntry>;

      if (typeof productId !== "string" || typeof quantity !== "number" || quantity <= 0) {
        return [];
      }

      const entry: CartEntry = { productId, quantity };

      if (typeof requestedUnitPrice === "number" && requestedUnitPrice > 0) {
        entry.requestedUnitPrice = requestedUnitPrice;
      }

      return [entry];
    });
  } catch {
    return [];
  }
}

function writeEntries(shopToken: string, entries: CartEntry[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(storageKey(shopToken));
    } else {
      window.localStorage.setItem(storageKey(shopToken), JSON.stringify(entries));
    }
  } catch {
    // 시크릿 모드 등 저장 실패 시에도 화면 동작은 유지한다.
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export interface ShopCartApi {
  entries: CartEntry[];
  /** localStorage 복원 완료 여부 (SSR 하이드레이션 불일치 방지용) */
  isLoaded: boolean;
  quantityOf: (productId: string) => number;
  /** 수량 직접 설정 (0 이하면 품목 제거) */
  setQuantity: (productId: string, quantity: number, unit: string, stockQuantity: number) => void;
  /** 단위 스텝만큼 증감 */
  stepQuantity: (productId: string, direction: 1 | -1, unit: string, stockQuantity: number) => void;
  /** 희망 단가 설정 — 0 이하나 숫자가 아니면 제거(미입력 처리) */
  setRequestedPrice: (productId: string, price: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
}

export function useShopCart(shopToken: string): ShopCartApi {
  const [entries, setEntries] = useState<CartEntry[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const sync = () => setEntries(readEntries(shopToken));

    sync();
    setIsLoaded(true);

    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);

    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [shopToken]);

  const quantityOf = useCallback(
    (productId: string) => entries.find((entry) => entry.productId === productId)?.quantity ?? 0,
    [entries]
  );

  const setQuantity = useCallback(
    (productId: string, quantity: number, unit: string, stockQuantity: number) => {
      const next = normalizeQuantity(quantity, unit, stockQuantity);
      const current = readEntries(shopToken).filter((entry) => entry.productId !== productId);

      writeEntries(shopToken, next > 0 ? [...current, { productId, quantity: next }] : current);
    },
    [shopToken]
  );

  const stepQuantity = useCallback(
    (productId: string, direction: 1 | -1, unit: string, stockQuantity: number) => {
      const current = readEntries(shopToken);
      const existing = current.find((entry) => entry.productId === productId)?.quantity ?? 0;
      const step = quantityStepFor(unit);
      const target = existing + step * direction;
      const next = normalizeQuantity(target, unit, stockQuantity);
      const remaining = current.filter((entry) => entry.productId !== productId);

      writeEntries(shopToken, next > 0 ? [...remaining, { productId, quantity: next }] : remaining);
    },
    [shopToken]
  );

  const setRequestedPrice = useCallback(
    (productId: string, price: number) => {
      const current = readEntries(shopToken);
      const existing = current.find((entry) => entry.productId === productId);

      if (!existing) {
        return;
      }

      const remaining = current.filter((entry) => entry.productId !== productId);
      const next: CartEntry = { ...existing };

      if (Number.isFinite(price) && price > 0) {
        next.requestedUnitPrice = price;
      } else {
        delete next.requestedUnitPrice;
      }

      writeEntries(shopToken, [...remaining, next]);
    },
    [shopToken]
  );

  const remove = useCallback(
    (productId: string) => {
      writeEntries(
        shopToken,
        readEntries(shopToken).filter((entry) => entry.productId !== productId)
      );
    },
    [shopToken]
  );

  const clear = useCallback(() => {
    writeEntries(shopToken, []);
  }, [shopToken]);

  return { entries, isLoaded, quantityOf, setQuantity, stepQuantity, setRequestedPrice, remove, clear };
}
