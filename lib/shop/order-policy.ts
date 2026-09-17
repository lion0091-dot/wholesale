/**
 * 미니샵 발주 정책 (최소 주문 금액/수량, 단위 스텝, 장바구니 검증).
 *
 * 서버 액션과 클라이언트 UI가 완전히 동일한 규칙으로 계산하도록 순수 함수로만 구성한다.
 * (금액 계산의 최종 권한은 항상 서버 액션에 있으며, 클라이언트는 미리보기 용도로만 사용한다.)
 */

/** 배송 1건 기준 최소 주문 금액 */
export const MIN_ORDER_AMOUNT = 50000;

/** 주문 1건에 필요한 최소 품목 수 */
export const MIN_ORDER_ITEM_COUNT = 1;

/** 단위별 수량 증감 단위 — 중량(kg/근)은 0.5 단위, 박스/팩 등은 1 단위 */
export function quantityStepFor(unit: string): number {
  const normalized = unit.trim().toLowerCase();

  return normalized === "kg" || normalized === "근" ? 0.5 : 1;
}

/** 품목별 최소 발주 수량 (증감 단위와 동일) */
export function minQuantityFor(unit: string): number {
  return quantityStepFor(unit);
}

/** 입력 수량을 단위 스텝에 맞추고 재고 범위로 보정한다. 유효하지 않으면 0 */
export function normalizeQuantity(raw: number, unit: string, stockQuantity: number): number {
  if (!Number.isFinite(raw) || raw <= 0 || stockQuantity <= 0) {
    return 0;
  }

  const step = quantityStepFor(unit);
  const stepped = Math.round(raw / step) * step;
  const capped = Math.min(stepped, stockQuantity);
  const rounded = Math.round(capped * 100) / 100;

  return rounded > 0 ? rounded : 0;
}

export interface CartLine {
  productId: string;
  name: string;
  category: string;
  subcategory: string | null;
  unit: string;
  /** 해당 식당에 실제 적용되는 단가 (맞춤 단가 우선) */
  unitPrice: number;
  /** 공급사 기준 단가 (맞춤 단가 절감액 표시용) */
  basePrice: number;
  quantity: number;
  stockQuantity: number;
  isCustomPrice: boolean;
  isSecretDeal: boolean;
}

export interface CartTotals {
  itemCount: number;
  totalQuantity: number;
  totalAmount: number;
  /** 기준 단가 대비 맞춤 단가 절감액 */
  savedAmount: number;
}

export type CartViolationCode =
  | "empty"
  | "min_order_amount"
  | "min_quantity"
  | "out_of_stock";

export interface CartViolation {
  code: CartViolationCode;
  message: string;
  productId?: string;
}

/** 품목 소계 (원 단위 반올림) */
export function lineSubtotal(line: CartLine): number {
  return Math.round(line.unitPrice * line.quantity);
}

export function cartTotals(lines: CartLine[]): CartTotals {
  return lines.reduce<CartTotals>(
    (acc, line) => ({
      itemCount: acc.itemCount + 1,
      totalQuantity: Math.round((acc.totalQuantity + line.quantity) * 100) / 100,
      totalAmount: acc.totalAmount + lineSubtotal(line),
      savedAmount:
        acc.savedAmount +
        Math.max(0, Math.round((line.basePrice - line.unitPrice) * line.quantity)),
    }),
    { itemCount: 0, totalQuantity: 0, totalAmount: 0, savedAmount: 0 }
  );
}

export interface CartValidation {
  ok: boolean;
  violations: CartViolation[];
  totals: CartTotals;
  /** 최소 주문 금액까지 남은 금액 (충족 시 0) */
  shortfallAmount: number;
}

/** 발주 가능 여부 검증 — 빈 장바구니 / 최소 주문 금액 / 최소 수량 / 재고 */
export function validateCart(lines: CartLine[]): CartValidation {
  const totals = cartTotals(lines);
  const violations: CartViolation[] = [];

  if (lines.length < MIN_ORDER_ITEM_COUNT) {
    violations.push({ code: "empty", message: "장바구니에 담긴 품목이 없습니다." });
  }

  lines.forEach((line) => {
    const minQuantity = minQuantityFor(line.unit);

    if (line.stockQuantity <= 0) {
      violations.push({
        code: "out_of_stock",
        productId: line.productId,
        message: `${line.name}은(는) 품절되어 발주할 수 없습니다.`,
      });
      return;
    }

    if (line.quantity > line.stockQuantity) {
      violations.push({
        code: "out_of_stock",
        productId: line.productId,
        message: `${line.name} 재고(${line.stockQuantity}${line.unit})를 초과했습니다.`,
      });
    }

    if (line.quantity < minQuantity) {
      violations.push({
        code: "min_quantity",
        productId: line.productId,
        message: `${line.name}은(는) 최소 ${minQuantity}${line.unit}부터 발주할 수 있습니다.`,
      });
    }
  });

  const shortfallAmount =
    lines.length > 0 ? Math.max(0, MIN_ORDER_AMOUNT - totals.totalAmount) : MIN_ORDER_AMOUNT;

  if (lines.length > 0 && shortfallAmount > 0) {
    violations.push({
      code: "min_order_amount",
      message: `최소 주문 금액은 ${MIN_ORDER_AMOUNT.toLocaleString()}원입니다. ${shortfallAmount.toLocaleString()}원을 더 담아주세요.`,
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    totals,
    shortfallAmount,
  };
}
