"use client";

import { useSyncExternalStore } from "react";

/**
 * 같은 미디어쿼리 문자열을 쓰는 모든 컴포넌트가 리스너 하나를 공유한다.
 * AuditLogPanel처럼 행마다 하나씩 마운트되는 컴포넌트가 각자
 * matchMedia 리스너를 따로 등록하면 목록이 길어질수록 리스너 수가 같이
 * 늘어나는 문제가 있어, 쿼리 문자열 단위로 MediaQueryList를 캐싱해 공유한다.
 */
const mediaQueryListCache = new Map<string, MediaQueryList>();

function getMediaQueryList(query: string): MediaQueryList {
  let list = mediaQueryListCache.get(query);

  if (!list) {
    list = window.matchMedia(query);
    mediaQueryListCache.set(query, list);
  }

  return list;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const list = getMediaQueryList(query);

      list.addEventListener("change", onStoreChange);
      return () => list.removeEventListener("change", onStoreChange);
    },
    () => getMediaQueryList(query).matches,
    () => false
  );
}
