import type { SupabaseClient } from "@supabase/supabase-js";

/** list_stock_adjustments RPC(마이그레이션 218) 한 줄 — 재고 조정·폐기·보정으로 장부가 바뀐 기록 한 건. 대표만 받는다. */
export interface StockAdjustmentRow {
  ledgerId: string;
  createdAt: string;
  /** LOSS = 폐기·파손으로 줄어든 것, ADJUSTMENT = 그 밖의 조정(실사·반품·보정) */
  kind: "LOSS" | "ADJUSTMENT";
  reason: string;
  productName: string;
  unit: string;
  /** 장부 변동량(−는 줄어듦) */
  qtyDelta: number;
  traceNo: string | null;
  unitPrice: number | null;
  /** 손실 금액(원). 박스 폐기만 안다 — 상품 단위 조정이나 단가 없는 박스는 null */
  lossAmount: number | null;
  byName: string;
}

export interface StockAdjustmentSummaryRow {
  unit: string;
  eventCount: number;
  lossQty: number;
  /** 금액을 아는 손실의 합계(원) */
  lossAmount: number;
  /** 금액을 모르는 손실 양 — 0원으로 치지 않고 따로 보여준다 */
  lossUnpricedQty: number;
  adjustInQty: number;
  adjustOutQty: number;
}

export type StockAdjustmentKind = "LOSS" | "ADJUSTMENT";

export const KIND_FILTERS: ReadonlyArray<{ value: "" | StockAdjustmentKind; label: string }> = [
  { value: "", label: "전체" },
  { value: "LOSS", label: "폐기·손실" },
  { value: "ADJUSTMENT", label: "조정·보정" },
];

export function kindLabel(kind: StockAdjustmentKind): string {
  return kind === "LOSS" ? "폐기·손실" : "조정·보정";
}

export function parseKindFilter(value: string | undefined): StockAdjustmentKind | null {
  return value === "LOSS" || value === "ADJUSTMENT" ? value : null;
}

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** 수량을 g 단위(소수 셋째 자리)까지만 보여주고 뒤쪽 0은 없앤다. */
export function formatAdjustQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export interface FetchAdjustmentsResult {
  rows: StockAdjustmentRow[];
  totalCount: number;
  summary: StockAdjustmentSummaryRow[];
}

/**
 * 재고 조정·손실 탭 데이터. 대표가 아니거나 탭이 꺼져 있으면 DB가 거부하므로 null — 화면은 안내를 보여준다.
 * 날짜는 YYYY-MM-DD(한국 시간 기준, 끝 날짜 포함).
 */
export async function fetchStockAdjustments(
  supabase: SupabaseClient,
  filters: { from: string | null; to: string | null; kind: StockAdjustmentKind | null; limit?: number }
): Promise<FetchAdjustmentsResult | null> {
  const [list, summary] = await Promise.all([
    supabase.rpc("list_stock_adjustments", {
      p_from: filters.from,
      p_to: filters.to,
      p_kind: filters.kind,
      p_limit: filters.limit ?? 200,
    }),
    supabase.rpc("summarize_stock_adjustments", { p_from: filters.from, p_to: filters.to }),
  ]);

  if (list.error || summary.error) {
    return null;
  }

  const listRows = (list.data ?? []) as Array<Record<string, unknown>>;

  return {
    rows: listRows.map((row) => ({
      ledgerId: String(row.ledger_id),
      createdAt: String(row.created_at),
      kind: row.kind === "LOSS" ? "LOSS" : "ADJUSTMENT",
      reason: String(row.reason ?? ""),
      productName: String(row.product_name ?? ""),
      unit: String(row.unit ?? "kg"),
      qtyDelta: Number(row.qty_delta),
      traceNo: (row.trace_no as string | null) ?? null,
      unitPrice: nullableNumber(row.unit_price),
      lossAmount: nullableNumber(row.loss_amount),
      byName: String(row.by_name ?? ""),
    })),
    totalCount: Number(listRows[0]?.total_count ?? 0),
    summary: ((summary.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      unit: String(row.unit ?? "kg"),
      eventCount: Number(row.event_count),
      lossQty: Number(row.loss_qty),
      lossAmount: Number(row.loss_amount),
      lossUnpricedQty: Number(row.loss_unpriced_qty),
      adjustInQty: Number(row.adjust_in_qty),
      adjustOutQty: Number(row.adjust_out_qty),
    })),
  };
}
