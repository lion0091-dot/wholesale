"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/sign-out-button";

interface AdminNavLink {
  href: string;
  label: string;
  icon: string;
}

// 관련 있는 링크끼리 묶어서 순서를 정한다(2026-09-19, app/dashboard/layout.tsx의
// NAV_GROUPS와 같은 원칙). ① 온보딩(리드 → 승인) ② 상품 ③ 구독료/매출 ④ 시스템.
const ADMIN_NAV_GROUPS: AdminNavLink[][] = [
  [
    { href: "/admin/retailer-leads", label: "입점 리드", icon: "📋" },
    { href: "/admin/suppliers", label: "공급사 승인", icon: "🏢" },
  ],
  [{ href: "/admin/categories", label: "상품 카테고리", icon: "🗂️" }],
  [
    { href: "/admin/billing", label: "청구·수납", icon: "🧾" },
    { href: "/admin/stats", label: "구독 추이", icon: "📈" },
    { href: "/admin/events", label: "할인 이벤트", icon: "🎉" },
  ],
  [{ href: "/admin/admins", label: "관리자 관리", icon: "🛡️" }],
];

const navIconStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "20px",
  fontSize: "15px",
  flexShrink: 0,
};

/**
 * 관리자 화면 공통 왼쪽 사이드바(2026-09-19, 상단 가로 탭이었던 components/admin-nav.tsx를
 * 대체). 공급사 대시보드 사이드바(app/dashboard/dashboard-shell.tsx)와 같은 CSS 클래스
 * (dash-shell/dash-sidebar/dash-nav-link 등)를 그대로 재사용해 모바일 드로어 동작까지
 * 동일하게 맞춘다.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const currentLabel =
    ADMIN_NAV_GROUPS.flat().find((link) => isActive(link.href))?.label ?? "플랫폼 관리자 콘솔";

  return (
    <div className="dash-shell" data-sidebar-open={sidebarOpen}>
      <button
        type="button"
        aria-label="메뉴 닫기"
        className="dash-backdrop"
        onClick={() => setSidebarOpen(false)}
      />

      <aside className="dash-sidebar">
        <div style={{ padding: "4px 10px 16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 600, color: "#94a3b8", letterSpacing: "0.04em" }}>
            미트 파트너스
          </div>
          <div style={{ fontSize: "19px", fontWeight: 800, color: "#ffffff", marginTop: "3px" }}>
            관리자 콘솔
          </div>
          <span
            style={{
              display: "inline-block",
              fontSize: "11px",
              fontWeight: 600,
              color: "#fca5a5",
              backgroundColor: "rgba(248, 113, 113, 0.12)",
              borderRadius: "999px",
              padding: "2px 9px",
              marginTop: "6px",
            }}
          >
            슈퍼 관리자
          </span>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {ADMIN_NAV_GROUPS.map((group, groupIndex) => (
            <div key={groupIndex} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {groupIndex > 0 && (
                <div
                  aria-hidden
                  style={{ height: "1px", backgroundColor: "#334155", margin: "6px 10px" }}
                />
              )}
              {group.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="dash-nav-link"
                  data-active={isActive(link.href)}
                >
                  <span aria-hidden style={navIconStyle}>{link.icon}</span>
                  <span>{link.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div
          style={{
            marginTop: "auto",
            paddingTop: "16px",
            paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
            borderTop: "1px solid #334155",
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          <Link href="/" style={{ color: "#cbd5e1", textDecoration: "underline" }}>
            ← 메인 허브
          </Link>
        </div>
      </aside>

      <div className="dash-body">
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "12px 16px",
            backgroundColor: "#ffffff",
            borderBottom: "1px solid #e2e8f0",
            position: "sticky",
            top: 0,
            zIndex: 30,
          }}
        >
          <button
            type="button"
            className="dash-menu-toggle"
            aria-label="메뉴 열기"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((prev) => !prev)}
            style={{
              width: "36px",
              height: "36px",
              fontSize: "18px",
              backgroundColor: "#f1f5f9",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            ☰
          </button>

          <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>{currentLabel}</div>

          <div style={{ marginLeft: "auto" }}>
            <SignOutButton />
          </div>
        </header>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>{children}</div>
      </div>
    </div>
  );
}
