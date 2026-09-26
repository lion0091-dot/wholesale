"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { totalTodo, visibleTodoItems, type TodoCounts } from "@/lib/supplier/todo-counts";

const REFRESH_MS = 30_000;

/**
 * 헤더의 "지금 할 일" 종 배지. 처음 값은 서버가 계산해서 내려주고, 화면이 보이는 동안
 * 30초마다·탭에 돌아올 때·화면을 옮길 때 다시 센다.
 */
export function TodoBell({ initialCounts }: { initialCounts: TodoCounts }) {
  const [counts, setCounts] = useState(initialCounts);
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

      const body = (await response.json()) as { counts: TodoCounts | null };

      if (body.counts) setCounts(body.counts);
    } catch {
      // 네트워크 오류는 다음 주기에 다시 시도한다.
    }
  }, []);

  useEffect(() => {
    setOpen(false);
    void refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, REFRESH_MS);

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

  // 패널은 화면 기준(fixed)으로 놓고 좌우 12px 안쪽에 가둔다 — 종 아이콘이 왼쪽에 붙은 좁은 폰 헤더에서
  // 아이콘 기준 오른쪽 정렬을 하면 패널이 화면 밖으로 밀려 항목 이름이 잘린다.
  const togglePanel = () => {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 24);
      const left = Math.min(Math.max(rect.right - width, 12), window.innerWidth - width - 12);

      setPanelPosition({ top: rect.bottom + 8, left, width });
    }

    setOpen((value) => !value);
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={togglePanel}
        aria-label={total > 0 ? `지금 할 일 ${total}건` : "지금 할 일 없음"}
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
        </div>
      )}
    </div>
  );
}
