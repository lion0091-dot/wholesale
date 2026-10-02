"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeRefresh } from "@/lib/hooks/use-realtime-refresh";
import { PushToggle } from "@/components/push-toggle";
import { OrderSoundToggle } from "@/components/order-sound-toggle";
import {
  countUnseen,
  describeNotice,
  INTERNAL_NOTICE_HREF,
  type InternalNotice,
} from "@/lib/supplier/internal-notices";
import { totalTodo, visibleTodoItems, type TodoCounts } from "@/lib/supplier/todo-counts";

/** Realtime이 조용히 끊긴 경우를 위한 안전망 주기 — 평소에는 Realtime 신호가 먼저 온다. */
const FALLBACK_REFRESH_MS = 5 * 60_000;

/** 알림함을 마지막으로 연 시각 — 이 기기(브라우저)에만 기억한다. 서버에 읽음 상태를 두지 않는다(사장님 결정 A안). */
const noticesSeenKey = (wholesalerId: string) => `todo-bell-notices-seen:${wholesalerId}`;

function readSeenAt(wholesalerId: string): string | null {
  try {
    return window.localStorage.getItem(noticesSeenKey(wholesalerId));
  } catch {
    return null;
  }
}

function writeSeenAt(wholesalerId: string, value: string) {
  try {
    window.localStorage.setItem(noticesSeenKey(wholesalerId), value);
  } catch {
    // 시크릿 창 등 저장이 막힌 환경 — 점이 계속 떠 있을 뿐 동작에는 지장 없다.
  }
}

function formatNoticeAt(value: string): string {
  const date = new Date(value);

  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 헤더의 "지금 할 일" 종 배지. 처음 값은 서버가 계산해서 내려주고, 그 뒤로는 주문·입고 박스·거래처 관계 표에
 * 변화가 생기는 순간(Realtime)·탭에 돌아올 때·화면을 옮길 때 다시 센다.
 * (2026-10-01까지는 30초 주기 조회였다.)
 *
 * 빨간 숫자는 "처리할 일"만 센다. 알림함(여신 한도·거래 정지/재개 기록)은 처리할 게 없는 통보라 숫자에 안 섞고,
 * 이 기기에서 아직 안 본 항목이 있으면 종 옆에 파란 점만 찍는다. 알림함은 대표·매니저에게만 온다(직원은 빈 배열).
 */
export function TodoBell({
  initialCounts,
  initialNotices,
  wholesalerId,
  pushConfigured,
}: {
  initialCounts: TodoCounts;
  initialNotices: InternalNotice[];
  wholesalerId: string;
  /** 서버에 웹푸시 키가 전부 있는가 — 없으면 "알림 받기" 줄을 안 그린다(알림톡만 동작). */
  pushConfigured: boolean;
}) {
  const [counts, setCounts] = useState(initialCounts);
  const [notices, setNotices] = useState(initialNotices);
  // 서버 렌더에서는 localStorage를 못 읽으므로 null(점 없음)로 시작하고 브라우저에서 바로잡는다.
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [seenLoaded, setSeenLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  // 서버 렌더는 PC 기준으로 시작하고, 폰이면 브라우저에서 바로잡는다(사이드바와 같은 900px 기준).
  const [isMobile, setIsMobile] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ top: 0, left: 12, width: 280 });
  const rootRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard/todo-counts", { cache: "no-store" });

      if (!response.ok) return;

      const body = (await response.json()) as { counts: TodoCounts | null; notices?: InternalNotice[] };

      if (body.counts) setCounts(body.counts);
      if (Array.isArray(body.notices)) setNotices(body.notices);
    } catch {
      // 네트워크 오류는 다음 주기에 다시 시도한다.
    }
  }, []);

  useEffect(() => {
    setOpen(false);
    void refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    setSeenAt(readSeenAt(wholesalerId));
    setSeenLoaded(true);
  }, [wholesalerId]);

  // 종 배지가 세는 세 항목의 출처: orders(새 주문·취소 요청), inbound_scans(확인 필요 박스).
  // wholesaler_retailers는 알림함(여신 한도·거래 상태) 갱신용.
  const watches = useMemo(
    () => [
      { table: "orders", filter: `wholesaler_id=eq.${wholesalerId}` },
      { table: "inbound_scans", filter: `wholesaler_id=eq.${wholesalerId}` },
      { table: "wholesaler_retailers", filter: `wholesaler_id=eq.${wholesalerId}` },
    ],
    [wholesalerId]
  );

  useRealtimeRefresh(watches, refresh);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, FALLBACK_REFRESH_MS);

    document.addEventListener("visibilitychange", tick);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);

    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(media.matches);

    update();
    media.addEventListener("change", update);

    return () => media.removeEventListener("change", update);
  }, []);

  const total = totalTodo(counts, isMobile);
  // 파란 점: 이 기기에서 아직 안 본 알림이 있을 때만. localStorage를 읽기 전(서버 렌더)에는 안 찍는다.
  const unseenNotices = seenLoaded ? countUnseen(notices, seenAt) : 0;
  // 목록 안에서는 "지금 열기 전" 기준으로 새 항목을 강조한다(열면서 seenAt이 바뀌어도 강조는 유지).
  const highlightSince = useRef<string | null>(null);

  // 패널은 화면 기준(fixed)으로 놓고 좌우 12px 안쪽에 가둔다 — 종 아이콘이 왼쪽에 붙은 좁은 폰 헤더에서
  // 아이콘 기준 오른쪽 정렬을 하면 패널이 화면 밖으로 밀려 항목 이름이 잘린다.
  const togglePanel = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 24);
      const left = Math.min(Math.max(rect.right - width, 12), window.innerWidth - width - 12);

      setPanelPosition({ top: rect.bottom + 8, left, width });

      // 여는 순간 지금까지의 알림을 본 것으로 기억한다(기기별).
      highlightSince.current = seenAt;
      const now = new Date().toISOString();

      writeSeenAt(wholesalerId, now);
      setSeenAt(now);
    }

    setOpen((value) => !value);
  };

  const ariaLabel = [
    total > 0 ? `지금 할 일 ${total}건` : "지금 할 일 없음",
    unseenNotices > 0 ? `새 알림 ${unseenNotices}건` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={togglePanel}
        aria-label={ariaLabel}
        aria-expanded={open}
        style={{
          position: "relative",
          border: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
          borderRadius: "8px",
          padding: "5px 9px",
          fontSize: "15px",
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        🔔
        {total > 0 && (
          <span
            style={{
              position: "absolute",
              top: "-6px",
              right: "-6px",
              minWidth: "18px",
              height: "18px",
              padding: "0 5px",
              boxSizing: "border-box",
              borderRadius: "999px",
              backgroundColor: "#dc2626",
              color: "#ffffff",
              fontSize: "11px",
              fontWeight: 800,
              lineHeight: "18px",
              textAlign: "center",
            }}
          >
            {total > 99 ? "99+" : total}
          </span>
        )}
        {unseenNotices > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              bottom: "-4px",
              right: "-4px",
              width: "10px",
              height: "10px",
              borderRadius: "999px",
              backgroundColor: "#2563eb",
              border: "2px solid #ffffff",
              boxSizing: "content-box",
            }}
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "fixed",
            top: panelPosition.top,
            left: panelPosition.left,
            width: panelPosition.width,
            zIndex: 50,
            backgroundColor: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.15)",
            padding: "6px",
          }}
        >
          <PushToggle configured={pushConfigured} />
          <OrderSoundToggle />

          <div style={{ padding: "8px 10px 6px", fontSize: "12px", fontWeight: 700, color: "#64748b" }}>
            지금 할 일
          </div>

          {total === 0 ? (
            <div style={{ padding: "10px", fontSize: "13px", color: "#475569" }}>지금 처리할 일이 없습니다.</div>
          ) : (
            visibleTodoItems(isMobile).filter((item) => counts[item.key] > 0).map((item) => (
              <Link
                key={item.key}
                href={item.href}
                role="menuitem"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  padding: "10px",
                  borderRadius: "8px",
                  fontSize: "13px",
                  color: "#0f172a",
                  textDecoration: "none",
                }}
              >
                <span>{item.label}</span>
                <span
                  style={{
                    minWidth: "22px",
                    padding: "1px 8px",
                    borderRadius: "999px",
                    backgroundColor: "#fee2e2",
                    color: "#991b1b",
                    fontSize: "12px",
                    fontWeight: 800,
                    textAlign: "center",
                  }}
                >
                  {counts[item.key]}
                </span>
              </Link>
            ))
          )}

          {notices.length > 0 && (
            <>
              <div
                style={{
                  margin: "6px 4px 0",
                  padding: "8px 6px 4px",
                  borderTop: "1px solid #e2e8f0",
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "#64748b",
                }}
              >
                최근 알림 <span style={{ fontWeight: 500 }}>(14일)</span>
              </div>
              <div style={{ maxHeight: "240px", overflowY: "auto" }}>
                {notices.map((notice) => {
                  const isNew = countUnseen([notice], highlightSince.current) > 0;

                  return (
                    <Link
                      key={notice.id}
                      href={INTERNAL_NOTICE_HREF}
                      role="menuitem"
                      style={{
                        display: "block",
                        padding: "8px 10px",
                        borderRadius: "8px",
                        fontSize: "12px",
                        lineHeight: 1.5,
                        color: "#0f172a",
                        textDecoration: "none",
                        backgroundColor: isNew ? "#eff6ff" : "transparent",
                      }}
                    >
                      <div>{describeNotice(notice)}</div>
                      <div style={{ fontSize: "11px", color: "#94a3b8" }}>{formatNoticeAt(notice.createdAt)}</div>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
