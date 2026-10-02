"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Realtime 구독을 걸기 직전에 로그인 토큰을 소켓에 먼저 실어 둔다.
 *
 * 브라우저 클라이언트는 쿠키의 세션을 비동기로 읽기 때문에, 화면이 열리자마자 구독하면 소켓이 토큰 없이(anon)
 * 먼저 붙을 수 있다. postgres_changes는 구독을 만든 시점의 권한으로 RLS를 판정하므로, 그러면 구독은 "성공"으로
 * 보이는데 내 행의 변화가 하나도 안 온다(2026-10-02 로컬 브라우저에서 확인: Node 클라이언트는 같은 계정으로 받는데
 * 브라우저는 못 받았다). 세션을 먼저 읽고 setAuth를 한 뒤에 구독하면 해결된다.
 */
export async function authorizeRealtime(supabase: SupabaseClient): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();

    if (data.session?.access_token) {
      await supabase.realtime.setAuth(data.session.access_token);
    }
  } catch {
    // 세션을 못 읽어도 구독은 시도한다 — 안 되면 기존처럼 주기 조회가 따라잡는다.
  }
}
