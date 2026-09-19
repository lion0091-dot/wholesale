"use client";

import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { SidebarShell, type SidebarNavItem } from "@/components/sidebar-shell";

// 관련 있는 링크끼리 묶어서 순서를 정한다(2026-09-19, app/dashboard/layout.tsx의
// NAV_GROUPS와 같은 원칙). ① 온보딩(리드 → 승인) ② 상품 ③ 구독료/매출 ④ 시스템.
const ADMIN_NAV_GROUPS: SidebarNavItem[][] = [
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

/**
 * 관리자 화면 공통 왼쪽 사이드바(2026-09-19, 상단 가로 탭이었던 components/admin-nav.tsx를
 * 대체). 공급사 대시보드 사이드바와 함께 components/sidebar-shell.tsx를 공유한다.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarShell
      navGroups={ADMIN_NAV_GROUPS}
      fallbackLabel="플랫폼 관리자 콘솔"
      headerRight={<SignOutButton />}
      brand={
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
      }
      footer={
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
      }
    >
      {children}
    </SidebarShell>
  );
}
