import type { SupabaseClient } from "@supabase/supabase-js";

/** get_inventory_valuation RPC(마이그레이션 210) 한 줄 — 상품별. "원가 관리" 기능을 쓸 수 있는 사람만 받는다. */
export interface ValuationRow {
  productId: string;
  productName: string;
  unit: string;
  boxCount: number;
  remainingQty: number;
  /** 매입단가를 아는 박스의 kg */
  valuedQty: number;
  valueAmount: number;
  /** 남아 있는데 매입단가를 모르는 kg — 0원으로 치지 않는다 */
  unpricedQty: number;
  /** 박스 없이 수동으로 넣은 재고(표시 재고 − 박스 합계) — 원가를 모른다 */
  boxlessQty: number;
  oldestAt: string | null;
  oldestDays: number | null;
}

export interface ValuationBoxRow {
  scanId: string;
  traceNo: string;
  remainingWeight: number;
  unitPrice: number | null;
  valueAmount: number | null;
  createdAt: string;
  daysOld: number;
  bestBefore: string | null;
  totalCount: number;
}

export interface ValuationLine extends ValuationRow {
  /** 평균 매입단가(단가를 아는 kg 기준) — 알 수 없으면 null */
  averageUnitCost: number | null;
  /** 단가를 모르는 재고(단가 미입력 박스 + 박스 없는 재고)가 있다 */
  incomplete: boolean;
}

export interface ValuationSummary {
  lines: ValuationLine[];
  totalValue: number;
  /** 단가를 모르는 kg 합계(단가 미입력 박스 + 박스 없는 재고) */
  unknownQty: number;
  oldestDays: number | null;
  incomplete: boolean;
}

/**
 * 오래됐는지 판단은 대표님이 한다 — 여기서는 사실(가장 오래된 박스가 며칠 됐는지)만 계산한다.
 * 소비기한이 임박한 재고는 알림벨(소비기한 임박 박스)이 따로 알려준다.
 */
export function summarizeValuation(rows: ValuationRow[]): ValuationSummary {
  const lines: ValuationLine[] = rows.map((row) => ({
    ...row,
    averageUnitCost: row.valuedQty > 0 ? Math.round(row.valueAmount / row.valuedQty) : null,
    incomplete: row.unpricedQty > 0 || row.boxlessQty > 0,
  }));

  const unknownQty = Math.round(lines.reduce((sum, line) => sum + line.unpricedQty + line.boxlessQty, 0) * 1000) / 1000;
  const ages = lines.map((line) => line.oldestDays).filter((days): days is number => days !== null);

  return {
    lines,
    totalValue: lines.reduce((sum, line) => sum + line.valueAmount, 0),
    unknownQty,
    oldestDays: ages.length > 0 ? Math.max(...ages) : null,
    incomplete: unknownQty > 0,
  };
}

/**
 * 로그인한 세션으로 부른다 — RPC가 "원가 관리" 기능이 켜져 있고 대표이거나 대표가 허용한 사람인지 검사한다.
 * 막히면(NOT_ALLOWED / FEATURE_DISABLED) null — 화면이 안내 문구를 보여준다.
 */
export async function fetchInventoryValuation(supabase: SupabaseClient): Promise<ValuationRow[] | null> {
  const { data, error } = await supabase.rpc("get_inventory_valuation");

  if (error || !Array.isArray(data)) return null;

  return (data as Array<Record<string, unknown>>).map((row) => ({
    productId: String(row.product_id),
    productName: String(row.product_name ?? ""),
    unit: String(row.unit ?? "kg"),
    boxCount: Number(row.box_count ?? 0),
    remainingQty: Number(row.remaining_qty ?? 0),
    valuedQty: Number(row.valued_qty ?? 0),
    valueAmount: Number(row.value_amount ?? 0),
    unpricedQty: Number(row.unpriced_qty ?? 0),
    boxlessQty: Number(row.boxless_qty ?? 0),
    oldestAt: (row.oldest_at as string | null) ?? null,
    oldestDays: row.oldest_days === null || row.oldest_days === undefined ? null : Number(row.oldest_days),
  }));
}

export async function fetchValuationBoxes(
  supabase: SupabaseClient,
  productId: string,
  limit = 200
): Promise<ValuationBoxRow[] | null> {
  const { data, error } = await supabase.rpc("get_inventory_valuation_boxes", { p_product_id: productId, p_limit: limit });

  if (error || !Array.isArray(data)) return null;

  return (data as Array<Record<string, unknown>>).map((row) => ({
    scanId: String(row.scan_id),
    traceNo: String(row.trace_no ?? ""),
    remainingWeight: Number(row.remaining_weight ?? 0),
    unitPrice: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
    valueAmount: row.value_amount === null || row.value_amount === undefined ? null : Number(row.value_amount),
    createdAt: String(row.created_at),
    daysOld: Number(row.days_old ?? 0),
    bestBefore: (row.best_before as string | null) ?? null,
    totalCount: Number(row.total_count ?? 0),
  }));
}
