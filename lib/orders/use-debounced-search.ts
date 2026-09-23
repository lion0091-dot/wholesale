"use client";

import { useEffect, useRef, useState } from "react";

export interface DebouncedSearchResult<T> {
  success: boolean;
  error?: string;
  data?: { entries: T[] };
}

const DEFAULT_DEBOUNCE_MS = 400;

/**
 * 검색어 입력 디바운스 + 응답 순서 역전 방지 공용 로직.
 *
 * 발주 이력 대상찾기(app/dashboard/history/orders/order-history-picker.tsx)와
 * 발주 관리 완료·취소 탭 검색(app/dashboard/orders/order-board.tsx)이 각자
 * 비슷한 디바운스를 따로 만들다 하나는 디바운스가 아예 빠져 있던 것을
 * (2026-09-21 code-review) 계기로 하나로 합쳤다.
 *
 * searchFn은 매 렌더마다 새로 만들어 넘겨도 된다 — ref로 최신 값만 참조하고,
 * 디바운스 타이머 자체는 keyword가 바뀔 때만 새로 잡는다(searchFn이 참조하는
 * 외부 상태가 바뀌었다고 타이머가 불필요하게 리셋되지 않는다).
 */
export function useDebouncedSearch<T>(
  searchFn: (keyword: string) => Promise<DebouncedSearchResult<T>>,
  debounceMs = DEFAULT_DEBOUNCE_MS
) {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const searchFnRef = useRef(searchFn);
  searchFnRef.current = searchFn;

  useEffect(() => {
    const trimmed = keyword.trim();

    // 검색어가 바뀔 때마다 세대를 올려서, 이미 나가있던 이전 요청의 응답이
    // 늦게 도착해도(타이머는 취소돼도 이미 네트워크로 나간 요청은 취소 안 됨)
    // 무시하도록 한다.
    requestId.current += 1;

    if (!trimmed) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }

    const thisRequestId = requestId.current;
    setLoading(true);

    const timer = setTimeout(() => {
      // searchFn이 reject하면(네트워크 오류 등) .catch() 없이는 setLoading(false)에
      // 도달하지 못해 로딩 상태에 갇힌다(2026-09-21 code-review 지적, 실버그).
      void searchFnRef.current(trimmed)
        .then((result) => {
          if (thisRequestId !== requestId.current) return;

          setLoading(false);

          if (result.success && result.data) {
            setResults(result.data.entries);
            setError(null);
          } else {
            setResults([]);
            setError(result.error ?? "검색에 실패했습니다.");
          }
        })
        .catch((error: unknown) => {
          if (thisRequestId !== requestId.current) return;

          setLoading(false);
          setResults([]);
          setError(error instanceof Error ? error.message : "검색에 실패했습니다.");
        });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [keyword, debounceMs]);

  return {
    keyword,
    setKeyword,
    results,
    loading,
    error,
    isSearching: keyword.trim().length > 0,
  };
}
