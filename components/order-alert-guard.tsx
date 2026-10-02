"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { authorizeRealtime } from "@/lib/supabase/realtime-auth";
import { useWebPush } from "@/lib/hooks/use-web-push";
import { playOrderChime, unlockAudioOnFirstGesture } from "@/lib/notifications/order-alert-sound";

const PROMPT_SEEN_PREFIX = "order-alert-prompt-seen:";
const TOAST_MS = 10_000;
/** 주문 머리글이 들어간 뒤 품목이 들어가고 실패하면 머리글이 지워진다 — 그 사이를 넘겨 확인한 뒤에만 알린다. */
const ORDER_SETTLE_MS = 2_500;

/**
 * 공급사 대시보드의 "주문 알림 지킴이" (대표·매니저).
 *  A. 이 기기에서 주문 알림(웹푸시)이 꺼져 있으면 화면 위에 빨간 줄이 계속 보인다. 켜면 사라진다.
 *  B. 이 업체로 처음 들어왔을 때는 한 번 더 크게 "알림을 켜세요"를 띄운다(켜기 / 나중에). 나중에를 누르면 빨간 줄만 남는다.
 *  F. 화면이 열려 있는 동안 새 주문이 들어오면 소리·진동과 함께 알림 창을 띄운다(Realtime orders INSERT).
 *     소리는 종 패널의 "새 주문 소리"에서 끌 수 있다.
 * 웹푸시를 못 쓰는 환경(서버 키 없음·카톡 안 브라우저 등)에서도 F는 동작한다.
 */
export function OrderAlertGuard({ wholesalerId, pushConfigured }: { wholesalerId: string; pushConfigured: boolean }) {
  const { enabled, state, error, enable } = useWebPush(pushConfigured, { syncOncePerSessionKey: wholesalerId });
  const [promptSeen, setPromptSeen] = useState(true); // 서버 렌더·확인 전에는 안 띄운다
  const [toast, setToast] = useState<{ id: number; sounded: boolean } | null>(null);

  useEffect(() => {
    try {
      setPromptSeen(window.localStorage.getItem(PROMPT_SEEN_PREFIX + wholesalerId) === "1");
    } catch {
      setPromptSeen(false);
    }
  }, [wholesalerId]);

  const dismissPrompt = useCallback(() => {
    setPromptSeen(true);

    try {
      window.localStorage.setItem(PROMPT_SEEN_PREFIX + wholesalerId, "1");
    } catch {
      // 저장이 막혀도 이번 접속에서는 다시 안 뜬다.
    }
  }, [wholesalerId]);

  // F — 새 주문 소리·알림 창
  useEffect(() => {
    const stopUnlock = unlockAudioOnFirstGesture();
    const supabase = createClient();
    let hideTimer: number | null = null;
    const settleTimers = new Set<number>();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    void (async () => {
      // 토큰을 먼저 실어야 RLS가 내 업체 행을 통과시킨다(realtime-auth.ts 설명 참고).
      await authorizeRealtime(supabase);

      if (cancelled) return;

      channel = supabase
        .channel(`order-alert:${wholesalerId}:${Math.random().toString(36).slice(2)}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "orders", filter: `wholesaler_id=eq.${wholesalerId}` },
          (payload) => {
            const orderId = (payload.new as { id?: string } | null)?.id;

            if (!orderId) return;

            // 주문 저장은 머리글(orders) → 품목(order_items) 순이고, 품목이 실패하면(핫딜 한도 초과 등) 머리글을 지운다.
            // INSERT 신호만 믿으면 사라질 주문에 소리가 울린다(유령 알림) — 잠시 뒤 주문과 품목이 남아 있는지 확인한다.
            const timer = window.setTimeout(async () => {
              settleTimers.delete(timer);

              if (cancelled) return;

              const [{ data: order }, { count: itemCount }] = await Promise.all([
                supabase.from("orders").select("id").eq("id", orderId).maybeSingle(),
                supabase.from("order_items").select("id", { count: "exact", head: true }).eq("order_id", orderId),
              ]);

              if (cancelled || !order || !itemCount) return;

              const sounded = playOrderChime();

              setToast({ id: Date.now(), sounded });

              if (hideTimer !== null) window.clearTimeout(hideTimer);

              hideTimer = window.setTimeout(() => setToast(null), TOAST_MS);
            }, ORDER_SETTLE_MS);

            settleTimers.add(timer);
          }
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      stopUnlock();
      settleTimers.forEach((timer) => window.clearTimeout(timer));

      if (hideTimer !== null) window.clearTimeout(hideTimer);

      if (channel) void supabase.removeChannel(channel);
    };
  }, [wholesalerId]);

  const needsAttention = enabled && (state === "off" || state === "denied" || state === "ios-install");
  const showPrompt = needsAttention && !promptSeen;

  const helpText =
    state === "ios-install"
      ? "아이폰은 사파리 공유 버튼 → \"홈 화면에 추가\"로 앱을 설치한 뒤, 그 앱에서 알림을 켜야 합니다."
      : state === "denied"
        ? "이 브라우저에서 알림이 차단돼 있습니다. 주소창 옆 자물쇠(설정)에서 알림을 허용한 뒤 새로고침해주세요."
        : null;

  return (
    <>
      {needsAttention && !showPrompt && (
        <div
          role="alert"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            marginBottom: "12px",
            padding: "10px 14px",
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "8px",
            fontSize: "13px",
            color: "#991b1b",
            lineHeight: 1.6,
          }}
        >
          <span>
            <strong>이 기기는 새 주문 알림이 꺼져 있습니다.</strong> 화면을 안 보고 있으면 주문을 놓칠 수 있어요.
            {helpText && <span style={{ display: "block", color: "#7f1d1d" }}>{helpText}</span>}
            {error && <span style={{ display: "block" }}>{error}</span>}
          </span>
          {state === "off" && (
            <button
              type="button"
              onClick={enable}
              style={{ border: "none", borderRadius: "6px", padding: "6px 14px", fontSize: "13px", fontWeight: 700, color: "#ffffff", backgroundColor: "#dc2626", cursor: "pointer" }}
            >
              알림 켜기
            </button>
          )}
        </div>
      )}

      {showPrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="주문 알림 켜기"
          style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", backgroundColor: "rgba(15,23,42,0.55)" }}
        >
          <div style={{ width: "100%", maxWidth: "380px", backgroundColor: "#ffffff", borderRadius: "14px", padding: "22px 20px", boxShadow: "0 10px 30px rgba(0,0,0,0.25)" }}>
            <div style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", marginBottom: "8px" }}>🔔 새 주문 알림을 켜세요</div>
            <p style={{ fontSize: "14px", color: "#334155", lineHeight: 1.7, marginBottom: "14px" }}>
              알림을 켜 두면 화면이 꺼져 있어도 새 주문·취소 요청이 바로 옵니다. 안 켜면 주문을 늦게 확인할 수 있어요.
            </p>
            {helpText && <p style={{ fontSize: "13px", color: "#b45309", lineHeight: 1.6, marginBottom: "14px" }}>{helpText}</p>}
            {error && <p style={{ fontSize: "13px", color: "#b91c1c", marginBottom: "12px" }}>{error}</p>}
            <div style={{ display: "flex", gap: "8px" }}>
              {state === "off" && (
                <button
                  type="button"
                  onClick={enable}
                  style={{ flex: 1, border: "none", borderRadius: "8px", padding: "12px", fontSize: "15px", fontWeight: 800, color: "#ffffff", backgroundColor: "#2563eb", cursor: "pointer" }}
                >
                  알림 켜기
                </button>
              )}
              <button
                type="button"
                onClick={dismissPrompt}
                style={{ flex: state === "off" ? "0 0 auto" : 1, border: "1px solid #cbd5e1", borderRadius: "8px", padding: "12px 16px", fontSize: "14px", color: "#475569", backgroundColor: "#ffffff", cursor: "pointer" }}
              >
                {state === "off" ? "나중에" : "확인"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          style={{ position: "fixed", right: "16px", bottom: "16px", zIndex: 90, maxWidth: "320px", padding: "14px 16px", borderRadius: "10px", backgroundColor: "#0f172a", color: "#ffffff", boxShadow: "0 8px 24px rgba(0,0,0,0.3)", fontSize: "14px", lineHeight: 1.6 }}
        >
          <div style={{ fontWeight: 800 }}>🛒 새 주문이 들어왔습니다</div>
          <div style={{ display: "flex", gap: "12px", marginTop: "6px", fontSize: "13px" }}>
            <Link href="/dashboard/orders" onClick={() => setToast(null)} style={{ color: "#93c5fd", fontWeight: 700 }}>
              주문 보기
            </Link>
            <button type="button" onClick={() => setToast(null)} style={{ border: "none", background: "none", color: "#94a3b8", cursor: "pointer", padding: 0 }}>
              닫기
            </button>
          </div>
          {!toast.sounded && (
            <div style={{ marginTop: "4px", fontSize: "11px", color: "#94a3b8" }}>
              (소리가 꺼져 있거나, 화면을 한 번 클릭한 뒤부터 소리가 납니다)
            </div>
          )}
        </div>
      )}
    </>
  );
}
