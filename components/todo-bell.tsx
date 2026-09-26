"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { TODO_ITEMS, totalTodo, type TodoCounts } from "@/lib/supplier/todo-counts";

const REFRESH_MS = 30_000;

/**
 * 헤더의 "지금 할 일" 종 배지. 처음 값은 서버가 계산해서 내려주고, 화면이 보이는 동안
 * 30초마다·탭에 돌아올 때·화면을 옮길 때 다시 센다.
 */
export function TodoBell({ initialCounts }: { initialCounts: TodoCounts }) {
  const [counts, setCounts] = useState(initialCounts);
  const [open, setOpen] = useState(false);
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

  const total = totalTodo(counts);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
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
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            zIndex: 50,
            width: "min(280px, calc(100vw - 32px))",
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
            TODO_ITEMS.filter((item) => counts[item.key] > 0).map((item) => (
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
