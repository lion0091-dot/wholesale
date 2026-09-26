"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface PillTab {
  label: string;
  href: string;
  /** true면 정확히 이 경로일 때만 활성(예: 개요 탭 "/dashboard"가 하위 경로까지 잡지 않게). */
  exact?: boolean;
  /** 이 경로들 아래에서도 이 탭을 활성으로 본다(예: 전표입력 탭이 전표 대조 화면에서도 켜지게). */
  alsoActiveFor?: readonly string[];
  /** true면 폰 화면(900px 이하)에서 탭을 숨긴다 — 사무실 PC 전용 화면. */
  desktopOnly?: boolean;
}

export function PillTabs({ tabs, ariaLabel }: { tabs: readonly PillTab[]; ariaLabel: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label={ariaLabel} style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
      {tabs.map((tab) => {
        const matches = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
        const active = tab.exact
          ? pathname === tab.href
          : matches(tab.href) || (tab.alsoActiveFor ?? []).some(matches);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={tab.desktopOnly ? "dash-desktop-only" : undefined}
            style={{
              padding: "8px 16px",
              borderRadius: "999px",
              fontSize: "13px",
              fontWeight: 700,
              textDecoration: "none",
              border: `1px solid ${active ? "#1d4ed8" : "#cbd5e1"}`,
              backgroundColor: active ? "#1d4ed8" : "#ffffff",
              color: active ? "#ffffff" : "#475569",
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
