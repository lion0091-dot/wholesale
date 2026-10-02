import type { SupabaseClient } from "@supabase/supabase-js";

/** get_pnl_by_month RPC(마이그레이션 219) 한 줄 — 한 달의 매출·원가·손실. 대표만 받는다. */
export interface PnlMonthRow {
  /** 그 달 1일(YYYY-MM-DD, 한국 시간 기준) */
  monthStart: string;
  orderCount: number;
  salesAmount: number;
  costAmount: number;
  /** 원가를 모르는 출고가 있는 상품 수(단가 없는 박스·박스 없는 재고) */
  unpricedItems: number;
  /** 금액을 아는 손실(박스 폐기) */
  lossAmount: number;
  /** 금액을 모르는 손실 기록 수 */
  lossUnpricedEvents: number;
}

/** get_pnl_by_product RPC 한 줄 — 수량은 단위가 상품마다 달라 이 줄 안에서만 의미가 있다. */
export interface PnlProductRow {
  productId: string;
  productName: string;
  unit: string;
  shippedQty: number;
  salesAmount: number;
  costAmount: number;
  unpricedQty: number;
  lossQty: number;
  lossAmount: number;
  lossUnpricedQty: number;
}

export interface PnlTotals {
  orderCount: number;
  salesAmount: number;
  costAmount: number;
  /** 매출총이익 = 매출 − 원가. 원가를 모르는 출고가 있으면 실제보다 크게 보일 수 있다(unpricedItems로 안내). */
  grossProfit: number;
  /** 매출총이익률(%). 매출이 0이면 null */
  marginRate: number | null;
  lossAmount: number;
  /** 매출총이익 − 금액 아는 손실 */
  profitAfterLoss: number;
  unpricedItems: number;
  lossUnpricedEvents: number;
}

/**
 * 월별 줄을 한 줄로 합친다. 손익은 영업이익이 아니라 매출총이익(마진) 기준이다 — 인건비·임대료 같은 비용은 시스템에 없다.
 * 원가를 모르는 출고(unpricedItems)와 금액을 모르는 손실(lossUnpricedEvents)은 금액에 넣지 않고 개수로만 따로 보여준다.
 */
export function summarizePnl(months: PnlMonthRow[]): PnlTotals {
  const sum = (pick: (row: PnlMonthRow) => number) => months.reduce((total, row) => total + pick(row), 0);
  const salesAmount = sum((row) => row.salesAmount);
  const costAmount = sum((row) => row.costAmount);
  const lossAmount = sum((row) => row.lossAmount);
  const grossProfit = salesAmount - costAmount;

  return {
    orderCount: sum((row) => row.orderCount),
    salesAmount,
    costAmount,
    grossProfit,
    marginRate: salesAmount > 0 ? Math.round((grossProfit / salesAmount) * 1000) / 10 : null,
    lossAmount,
    profitAfterLoss: grossProfit - lossAmount,
    unpricedItems: sum((row) => row.unpricedItems),
    lossUnpricedEvents: sum((row) => row.lossUnpricedEvents),
  };
}

/** 상품 한 줄의 매출총이익과 마진율(%). 매출이 0이면 마진율은 null. */
export function productGrossProfit(row: PnlProductRow): { grossProfit: number; marginRate: number | null } {
  const grossProfit = row.salesAmount - row.costAmount;

  return {
    grossProfit,
    marginRate: row.salesAmount > 0 ? Math.round((grossProfit / row.salesAmount) * 1000) / 10 : null,
  };
}

/** "2026-10-01" → "2026년 10월" */
export function formatMonthLabel(monthStart: string): string {
  const [year, month] = monthStart.split("-");

  return `${year}년 ${Number(month)}월`;
}

export function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export interface FetchPnlResult {
  months: PnlMonthRow[];
  products: PnlProductRow[];
}

/**
 * 손익 관리 탭 데이터. 대표가 아니거나 탭이 꺼져 있거나 기간이 잘못되면 DB가 거부하므로 null — 화면은 안내를 보여준다.
 * 날짜는 YYYY-MM-DD(한국 시간 기준, 끝 날짜 포함).
 */
export async function fetchPnl(
  supabase: SupabaseClient,
  range: { from: string | null; to: string | null }
): Promise<FetchPnlResult | null> {
  const args = { p_from: range.from, p_to: range.to };
  const [month, product] = await Promise.all([
    supabase.rpc("get_pnl_by_month", args),
    supabase.rpc("get_pnl_by_product", args),
  ]);

  if (month.error || product.error) {
    return null;
  }

  return {
    months: ((month.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      monthStart: String(row.month_start),
      orderCount: Number(row.order_count),
      salesAmount: Number(row.sales_amount),
      costAmount: Number(row.cost_amount),
      unpricedItems: Number(row.unpriced_items),
      lossAmount: Number(row.loss_amount),
      lossUnpricedEvents: Number(row.loss_unpriced_events),
    })),
    products: ((product.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      productId: String(row.product_id),
      productName: String(row.product_name ?? ""),
      unit: String(row.unit ?? "kg"),
      shippedQty: Number(row.shipped_qty),
      salesAmount: Number(row.sales_amount),
      costAmount: Number(row.cost_amount),
      unpricedQty: Number(row.unpriced_qty),
      lossQty: Number(row.loss_qty),
      lossAmount: Number(row.loss_amount),
      lossUnpricedQty: Number(row.loss_unpriced_qty),
    })),
  };
}
