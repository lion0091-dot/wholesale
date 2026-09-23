"use client";

import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { SidebarShell, type SidebarNavItem } from "@/components/sidebar-shell";
import type { SubscriptionStatus } from "@/types/database";

/** 관리자 화면(app/admin/suppliers/supplier-approval-list.tsx)의 SUB_BADGES와 라벨/색을 맞춤. */
const SUBSCRIPTION_BADGES: Record<SubscriptionStatus, { label: string; bg: string; color: string }> = {
  trial: { label: "무료 체험중", bg: "#e0e7ff", color: "#3730a3" },
  active: { label: "구독 활성", bg: "#dcfce7", color: "#166534" },
  overdue: { label: "구독료 미납", bg: "#fee2e2", color: "#991b1b" },
  cancelled: { label: "구독 해지됨", bg: "#f1f5f9", color: "#64748b" },
};

export type DashboardNavItem = SidebarNavItem;

interface DashboardShellProps {
  navGroups: DashboardNavItem[][];
  /** 좁은 화면에서 navGroups 대신 보여줄 축약 메뉴 (SidebarShell 참고) */
  mobileNavGroups?: DashboardNavItem[][];
  organizationName: string;
  /** 표시용 계정 이름 (profiles.name → 카카오 닉네임 → "사용자"). 항상 값이 있다. */
  displayName: string;
  roleLabel: string;
  /** null이면 배지 자체를 숨김(슈퍼관리자 감독 열람, 업체 레코드 없는 계정 등) */
  subscriptionStatus: SubscriptionStatus | null;
  isDemoMode: boolean;
  children: React.ReactNode;
}

export function DashboardShell({
  navGroups,
  mobileNavGroups,
  organizationName,
  displayName,
  roleLabel,
  subscriptionStatus,
  isDemoMode,
  children,
}: DashboardShellProps) {
  return (
    <SidebarShell
      navGroups={navGroups}
      mobileNavGroups={mobileNavGroups}
      fallbackLabel="도매업체 통합관리시스템"
      headerSubtitle={organizationName}
      mainMaxWidth="1100px"
      brand={
        <div style={{ padding: "4px 10px 16px" }}>
          <div style={{ fontSize: "10px", fontWeight: 600, color: "#94a3b8", letterSpacing: "0.04em" }}>
            도매업체 통합관리시스템
          </div>
          <div
            style={{
              fontSize: "19px",
              fontWeight: 800,
              color: "#ffffff",
              marginTop: "3px",
              wordBreak: "keep-all",
            }}
          >
            {organizationName}
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
            {roleLabel}
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
            lineHeight: 1.6,
            wordBreak: "break-all",
          }}
        >
          {/* 데모 모드 안내는 헤더 배지(isDemoMode)가 담당한다. 이름은 인증 상태와 무관하다. */}
          {displayName}
          <div style={{ marginTop: "8px" }}>
            <Link href="/" style={{ color: "#cbd5e1", textDecoration: "underline" }}>
              서비스 홈 →
            </Link>
          </div>
        </div>
      }
      headerRight={
        <>
          {subscriptionStatus && (
            <Link
              href="/dashboard/billing"
              title="청구서 보기"
              style={{
                fontSize: "11px",
                fontWeight: 700,
                color: SUBSCRIPTION_BADGES[subscriptionStatus].color,
                backgroundColor: SUBSCRIPTION_BADGES[subscriptionStatus].bg,
                borderRadius: "6px",
                padding: "5px 8px",
                textDecoration: "none",
              }}
            >
              {SUBSCRIPTION_BADGES[subscriptionStatus].label}
            </Link>
          )}
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
        </>
      }
    >
      {children}
    </SidebarShell>
  );
}
