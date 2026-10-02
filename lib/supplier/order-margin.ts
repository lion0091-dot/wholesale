import type { SupabaseClient } from "@supabase/supabase-js";

/** get_order_margin RPC(마이그레이션 208) 한 줄 — 상품별. 대표(owner)만 받을 수 있다. */
export interface OrderMarginRow {
  productId: string | null;
  productName: string;
  unit: string;
  soldQty: number;
  salesAmount: number;
  shippedQty: number;
  costAmount: number;
  /** 나갔는데 원가를 모르는 양(박스 없는 재고분·매입단가 미입력 박스). 원가 0으로 치지 않는다. */
  unpricedQty: number;
}

export interface OrderMarginLine extends OrderMarginRow {
  marginAmount: number;
  /** 판매금액이 0이면 null */
  marginRate: number | null;
  /** 원가를 모르는 양이 있어 마진이 실제보다 높게 보일 수 있다. */
  incomplete: boolean;
}

export interface OrderMarginSummary {
  lines: OrderMarginLine[];
  salesAmount: number;
  costAmount: number;
  marginAmount: number;
  marginRate: number | null;
  unpricedQty: number;
  incomplete: boolean;
  /** 나간 박스·재고가 하나도 없으면 원가를 말할 수 없다(접수대기·취소 등). 패널을 숨긴다. */
  hasShipment: boolean;
}

function rate(margin: number, sales: number): number | null {
  return sales > 0 ? Math.round((margin / sales) * 1000) / 10 : null;
}

export function summarizeOrderMargin(rows: OrderMarginRow[]): OrderMarginSummary {
  const lines = rows.map((row) => {
    const marginAmount = row.salesAmount - row.costAmount;

    return {
      ...row,
      marginAmount,
      marginRate: rate(marginAmount, row.salesAmount),
      incomplete: row.unpricedQty > 0,
    };
  });

  const salesAmount = lines.reduce((sum, line) => sum + line.salesAmount, 0);
  const costAmount = lines.reduce((sum, line) => sum + line.costAmount, 0);
  const marginAmount = salesAmount - costAmount;
  const unpricedQty = Math.round(lines.reduce((sum, line) => sum + line.unpricedQty, 0) * 1000) / 1000;

  return {
    lines,
    salesAmount,
    costAmount,
    marginAmount,
    marginRate: rate(marginAmount, salesAmount),
    unpricedQty,
    incomplete: unpricedQty > 0,
    hasShipment: lines.some((line) => line.shippedQty > 0),
  };
}

/**
 * 로그인한 세션으로 부른다 — RPC가 대표만 통과시키고 그 외(매니저·직원·고객·슈퍼관리자)는 NOT_OWNER 오류다.
 * 오류는 "보여줄 수 없음"(null)으로 처리한다 — 원가 패널이 주문 화면을 깨뜨리면 안 되고, 대표가 아니면 패널이 안 보이는 게 정상이다.
 */
export async function fetchOrderMargin(supabase: SupabaseClient, orderId: string): Promise<OrderMarginSummary | null> {
  const { data, error } = await supabase.rpc("get_order_margin", { p_order_id: orderId });

  if (error || !Array.isArray(data)) return null;

  const summary = summarizeOrderMargin(
    (data as Array<Record<string, unknown>>).map((row) => ({
      productId: (row.product_id as string | null) ?? null,
      productName: String(row.product_name ?? ""),
      unit: String(row.unit ?? "kg"),
      soldQty: Number(row.sold_qty ?? 0),
      salesAmount: Number(row.sales_amount ?? 0),
      shippedQty: Number(row.shipped_qty ?? 0),
      costAmount: Number(row.cost_amount ?? 0),
      unpricedQty: Number(row.unpriced_qty ?? 0),
    }))
  );

  return summary.hasShipment ? summary : null;
}
