"use server";

import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import {
  ORDER_LIST_SELECT_COLUMNS,
  ORDER_LIST_SELECT_COLUMNS_RETAILER_INNER,
  mapOrderJoinRow,
  type OrderJoinRow,
  type OrderRow,
} from "@/lib/orders/order-row";
import { ORDER_HISTORY_PAGE_SIZE, ORDER_HISTORY_SEARCH_LIMIT } from "@/lib/orders/history-range";

export interface ActionResult<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * 발주이력 "대상 찾기" 전용 조회 — app/dashboard/orders/actions.ts의
 * getHistoricalOrdersAction과 달리 상태 무관 전체 발주를 대상으로 한다
 * (감사이력은 진행 중인 발주에도 필요하다 — 완료/취소된 것만 볼 이유가 없음).
 */
export async function listOrdersForHistoryAction(
  rangeDays: number | null,
  offset = 0
): Promise<ActionResult<{ entries: OrderRow[]; totalCount: number; hasMore: boolean }>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const safeRangeDays =
      rangeDays !== null && Number.isFinite(rangeDays) && rangeDays > 0 ? Math.floor(rangeDays) : null;

    const supabase = await createClient();

    let query = supabase
      .from("orders")
      .select(ORDER_LIST_SELECT_COLUMNS, { count: "exact" })
      .eq("wholesaler_id", scope.wholesalerId);

    if (safeRangeDays !== null) {
      const cutoff = new Date(Date.now() - safeRangeDays * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("ordered_at", cutoff);
    }

    const { data, count, error } = await query
      .order("ordered_at", { ascending: false })
      .range(safeOffset, safeOffset + ORDER_HISTORY_PAGE_SIZE - 1);

    if (error) {
      return { success: false, error: "발주 조회에 실패했습니다." };
    }

    const entries = ((data ?? []) as OrderJoinRow[]).map(mapOrderJoinRow);
    const totalCount = count ?? 0;

    return {
      success: true,
      data: { entries, totalCount, hasMore: safeOffset + entries.length < totalCount },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "발주 조회 중 오류가 발생했습니다.",
    };
  }
}

/** 발주번호/거래처명으로 전체 기간 검색 (상태 무관) */
export async function searchOrdersForHistoryAction(
  keyword: string
): Promise<ActionResult<{ entries: OrderRow[] }>> {
  try {
    const scope = await getSupplierScope();

    if (!scope?.wholesalerId) {
      return { success: false, error: "로그인이 필요합니다." };
    }

    const trimmed = keyword.trim();

    if (!trimmed) {
      return { success: true, data: { entries: [] } };
    }

    const supabase = await createClient();
    const pattern = `%${trimmed.replace(/[%_]/g, (char) => `\\${char}`)}%`;

    const [byOrderNumber, byRetailerName] = await Promise.all([
      supabase
        .from("orders")
        .select(ORDER_LIST_SELECT_COLUMNS)
        .eq("wholesaler_id", scope.wholesalerId)
        .ilike("order_number", pattern)
        .order("ordered_at", { ascending: false })
        .limit(ORDER_HISTORY_SEARCH_LIMIT),
      supabase
        .from("orders")
        .select(ORDER_LIST_SELECT_COLUMNS_RETAILER_INNER)
        .eq("wholesaler_id", scope.wholesalerId)
        .ilike("retailers.restaurant_name", pattern)
        .order("ordered_at", { ascending: false })
        .limit(ORDER_HISTORY_SEARCH_LIMIT),
    ]);

    if (byOrderNumber.error || byRetailerName.error) {
      return { success: false, error: "발주 검색에 실패했습니다." };
    }

    const merged = new Map<string, OrderJoinRow>();

    for (const row of (byOrderNumber.data ?? []) as OrderJoinRow[]) {
      merged.set(row.id, row);
    }

    for (const row of (byRetailerName.data ?? []) as OrderJoinRow[]) {
      merged.set(row.id, row);
    }

    const entries = Array.from(merged.values())
      .sort((a, b) => (a.ordered_at < b.ordered_at ? 1 : -1))
      .slice(0, ORDER_HISTORY_SEARCH_LIMIT)
      .map(mapOrderJoinRow);

    return { success: true, data: { entries } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "발주 검색 중 오류가 발생했습니다.",
    };
  }
}
