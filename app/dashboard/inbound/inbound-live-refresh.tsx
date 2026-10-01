"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeRefresh } from "@/lib/hooks/use-realtime-refresh";
import { recentSelfChange } from "@/lib/livestock/self-change-marker";

/** 내가 방금 바꾼 것(스캔·상품 지정 등)에 대한 Realtime 신호는 이 시간 안에 오므로 건너뛴다 — 그 화면은 이미 스스로 다시 그렸다. */
const SELF_CHANGE_WINDOW_MS = 2_500;

/**
 * 다른 사람(현장)이 찍은 박스가 이 화면에도 바로 보이게 한다 — 이 업체의 입고 박스(inbound_scans) 표에 변화가
 * 오면 화면을 서버에서 다시 그린다(router.refresh). 내가 찍은 박스는 원래 그 자리에서 바로 갱신되므로(스캔 뷰가
 * 스스로 refresh) 이건 "남이 찍은 것"을 위한 장치다. 2026-10-01 전에는 새로고침해야만 보였다.
 *
 * 입력 중 보호: 사무실에서 상품 지정 드롭다운·실중량 칸을 만지는 동안 화면이 다시 그려지면 흔들리므로,
 * 입력 칸에 커서가 있거나 탭이 가려져 있으면 미뤄 뒀다가 커서가 빠지거나 탭에 돌아오면 그때 한 번 그린다.
 */
export function InboundLiveRefresh({ wholesalerId }: { wholesalerId: string }) {
  const router = useRouter();
  const deferred = useRef(false);

  const isTyping = () => {
    const active = document.activeElement;

    return active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement;
  };

  const refreshNow = useCallback(() => {
    deferred.current = false;
    router.refresh();
  }, [router]);

  const onChange = useCallback(() => {
    if (recentSelfChange(SELF_CHANGE_WINDOW_MS)) return;

    if (document.visibilityState === "hidden" || isTyping()) {
      deferred.current = true;

      return;
    }

    refreshNow();
  }, [refreshNow]);

  const watches = useMemo(() => [{ table: "inbound_scans", filter: `wholesaler_id=eq.${wholesalerId}` }], [wholesalerId]);

  // 연속 스캔은 묶어서 한 번만 그린다(박스 하나당 행이 몇 번 바뀐다).
  useRealtimeRefresh(watches, onChange, { debounceMs: 800 });

  useEffect(() => {
    const flush = () => {
      if (!deferred.current) return;
      if (document.visibilityState === "hidden" || isTyping()) return;

      refreshNow();
    };

    // focusout 시점엔 다음 칸으로 커서가 아직 안 옮겨져 있다(activeElement가 body) — 한 틱 뒤에 봐야
    // "칸에서 칸으로 옮기는 중"을 입력 끝으로 오해하지 않는다.
    const flushAfterFocusMove = () => window.setTimeout(flush, 0);

    document.addEventListener("focusout", flushAfterFocusMove);
    document.addEventListener("visibilitychange", flush);

    return () => {
      document.removeEventListener("focusout", flushAfterFocusMove);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [refreshNow]);

  return null;
}
