"use client";

import { useEffect, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

export interface RealtimeTableWatch {
  /** public 스키마의 표 이름 */
  table: string;
  /** Realtime 필터 — 예: `wholesaler_id=eq.<uuid>`. 한 컬럼만 걸 수 있다. */
  filter: string;
}

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * 지정한 표에 변화가 생기면 onChange를 부른다(짧은 간격의 변화는 모아서 한 번).
 *
 * 행 내용은 쓰지 않고 "바뀌었다"는 신호로만 쓴다 — 실제 값은 기존 서버 조회가 다시 센다.
 * 그래야 RLS·계산 규칙이 서버 한 곳에 남고, 화면은 30초 주기 조회를 Realtime 신호로 바꾸기만 하면 된다.
 *
 * 소켓이 끊겼다 다시 붙으면(폰 화면 꺼짐 등) 그 사이 놓친 변화를 따라잡도록 onChange를 한 번 더 부른다.
 * 삭제(DELETE)는 필터 때문에 안 온다(Supabase가 삭제 행의 키만 보내므로) — 화면 이동·탭 복귀 시 재조회가 메운다.
 */
export function useRealtimeRefresh(
  watches: RealtimeTableWatch[],
  onChange: () => void,
  options: { enabled?: boolean; debounceMs?: number } = {}
) {
  const { enabled = true, debounceMs = DEFAULT_DEBOUNCE_MS } = options;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 배열을 매 렌더마다 새로 만들어 넘겨도 내용이 같으면 재구독하지 않는다.
  const watchKey = JSON.stringify(watches);

  useEffect(() => {
    if (!enabled || watches.length === 0) return;

    const supabase = createClient();
    let timer: number | null = null;
    let subscribedOnce = false;
    let cancelled = false;

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!cancelled) onChangeRef.current();
      }, debounceMs);
    };

    let channel: RealtimeChannel = supabase.channel(`refresh:${watchKey}:${Math.random().toString(36).slice(2)}`);

    for (const watch of watches) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: watch.table, filter: watch.filter },
        schedule
      );
    }

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;

      // 첫 구독은 화면이 방금 서버에서 받은 값으로 시작하므로 건너뛰고, 재연결일 때만 따라잡는다.
      if (subscribedOnce) schedule();
      subscribedOnce = true;
    });

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
    // watches 내용은 watchKey로 비교한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, debounceMs, watchKey]);
}
