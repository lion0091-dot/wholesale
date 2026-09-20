"use client";

import { useState } from "react";

export interface OrderHistoryPage<T> {
  entries: T[];
  totalCount: number;
  hasMore: boolean;
}

export interface OrderHistoryPageResult<T, TExtra = unknown> {
  success: boolean;
  error?: string;
  data?: OrderHistoryPage<T> & TExtra;
}

/**
 * "조회 구간(30일/3개월/전체) + 더보기" 공용 상태/로직.
 *
 * app/dashboard/history/orders/order-history-picker.tsx(발주 이력 대상 찾기)와
 * app/shop/[shop_token]/orders/order-history-view.tsx(고객 발주내역)가 거의 똑같은
 * state+핸들러를 각자 들고 있다가(2026-09-21 code-review 지적) 하나로 합쳤다.
 *
 * 구간 변경 실패 시 rangeDays를 성공했을 때만 반영한다 — 실패해도 버튼이 그 값으로
 * "선택된 채" 굳어버리면(예전 버그) 같은 버튼을 다시 눌러도 값이 안 바뀌어(다음 값과
 * 동일 판정) 재시도가 막힌다.
 */
export function useOrderHistoryPagination<T, TExtra = unknown>(
  initial: OrderHistoryPage<T>,
  initialRangeDays: number,
  fetchPage: (rangeDays: number | null, offset: number) => Promise<OrderHistoryPageResult<T, TExtra>>,
  /** 구간 변경/더보기 성공 시 호출 — 그 시점에 실제로 적용된 구간값을 같이 받는다. */
  onPageLoaded?: (data: OrderHistoryPage<T> & TExtra, appliedRangeDays: number | null) => void
) {
  const [entries, setEntries] = useState<T[]>(initial.entries);
  const [rangeDays, setRangeDays] = useState<number | null>(initialRangeDays);
  const [totalCount, setTotalCount] = useState(initial.totalCount);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isBusy = rangeLoading || moreLoading;

  const changeRange = async (nextRangeDays: number | null) => {
    if (nextRangeDays === rangeDays || isBusy) return;

    setRangeLoading(true);
    setErrorMessage(null);

    const result = await fetchPage(nextRangeDays, 0);
    setRangeLoading(false);

    if (!result.success || !result.data) {
      setErrorMessage(result.error ?? "조회에 실패했습니다. 잠시 후 다시 시도해주세요.");
      return;
    }

    setRangeDays(nextRangeDays);
    setEntries(result.data.entries);
    setTotalCount(result.data.totalCount);
    setHasMore(result.data.hasMore);
    onPageLoaded?.(result.data, nextRangeDays);
  };

  const loadMore = async () => {
    if (isBusy) return;

    setMoreLoading(true);
    const result = await fetchPage(rangeDays, entries.length);
    setMoreLoading(false);

    if (!result.success || !result.data) {
      setErrorMessage(result.error ?? "조회에 실패했습니다. 잠시 후 다시 시도해주세요.");
      return;
    }

    setEntries((prev) => [...prev, ...result.data!.entries]);
    setHasMore(result.data.hasMore);
    onPageLoaded?.(result.data, rangeDays);
  };

  return {
    entries,
    setEntries,
    rangeDays,
    totalCount,
    setTotalCount,
    hasMore,
    setHasMore,
    rangeLoading,
    moreLoading,
    isBusy,
    errorMessage,
    setErrorMessage,
    changeRange,
    loadMore,
  };
}
