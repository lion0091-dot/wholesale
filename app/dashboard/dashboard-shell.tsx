"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/sign-out-button";

export interface DashboardNavItem {
  label: string;
  href: string;
  icon: string;
  /** 아직 구현되지 않은 메뉴 — 링크 대신 '준비중' 배지로 표시한다. */
  ready: boolean;
}

interface DashboardShellProps {
  navItems: DashboardNavItem[];
  organizationName: string;
  userEmail: string | null;
  roleLabel: string;
  isDemoMode: boolean;
  children: ReactNode;
}

export function DashboardShell({
  navItems,
  organizationName,
  userEmail,
  roleLabel,
  isDemoMode,
  children,
}: DashboardShellProps) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 모바일 드로어는 경로 이동 시 자동으로 닫는다.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const currentLabel =
    navItems.find((item) => isActive(item.href))?.label ?? "백오피스";

  return (
    <div className="dash-shell" data-sidebar-open={sidebarOpen}>
      {/* 모바일 드로어 배경 (클릭 시 닫힘) */}
      <button
        type="button"
        aria-label="메뉴 닫기"
        className="dash-backdrop"
        onClick={() => setSidebarOpen(false)}
      />

      <aside className="dash-sidebar">
        <div style={{ padding: "4px 10px 16px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: "#f87171", letterSpacing: "0.04em" }}>
            SUPPLIER BACKOFFICE
          </div>
          <div
            style={{
              fontSize: "16px",
              fontWeight: 800,
              color: "#ffffff",
              marginTop: "4px",
              wordBreak: "keep-all",
            }}
          >
            {organizationName}
          </div>
          <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "4px" }}>{roleLabel}</div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {navItems.map((item) =>
            item.ready ? (
              <Link
                key={item.href}
                href={item.href}
                className="dash-nav-link"
                data-active={isActive(item.href)}
              >
                <span aria-hidden>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            ) : (
              <span
                key={item.href}
                className="dash-nav-link"
                data-disabled="true"
                aria-disabled="true"
                title="다음 단계에서 구현 예정입니다."
              >
                <span aria-hidden>{item.icon}</span>
                <span>{item.label}</span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "10px",
                    fontWeight: 700,
                    color: "#94a3b8",
                    backgroundColor: "#1e293b",
                    borderRadius: "4px",
                    padding: "2px 5px",
                  }}
                >
                  준비중
                </span>
              </span>
            )
          )}
        </nav>

        <div
          style={{
            marginTop: "auto",
            paddingTop: "16px",
            borderTop: "1px solid #1e293b",
            fontSize: "11px",
            color: "#94a3b8",
            lineHeight: 1.6,
            wordBreak: "break-all",
          }}
        >
          {userEmail ?? "데모 모드 (미인증)"}
          <div style={{ marginTop: "8px" }}>
            <Link href="/" style={{ color: "#cbd5e1", textDecoration: "underline" }}>
              서비스 홈 →
            </Link>
          </div>
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

          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>{currentLabel}</div>
            <div style={{ fontSize: "11px", color: "#64748b" }}>{organizationName}</div>
          </div>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
            {isDemoMode && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "#92400e",
                  backgroundColor: "#fef3c7",
                  border: "1px solid #fde68a",
                  borderRadius: "6px",
                  padding: "5px 8px",
                }}
              >
                데모 모드
              </span>
            )}
            <SignOutButton />
          </div>
        </header>

        <main style={{ flex: 1, padding: "20px 16px", maxWidth: "1100px", width: "100%" }}>
          {children}
        </main>
      </div>
    </div>
  );
}
