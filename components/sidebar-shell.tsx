"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 왼쪽 사이드바 + 모바일 드로어 공통 레이아웃.
 *
 * 공급사 대시보드(app/dashboard/dashboard-shell.tsx)와 어드민(components/admin-shell.tsx)이
 * 거의 동일한 마크업(백드롭/사이드바/드로어 토글/헤더)을 각자 들고 있다가, 사이드바 그룹화
 * 리팩터링(2026-09-19) 때 flex gap 버그가 두 파일에 똑같이 생기는 걸 보고 하나로 합쳤다
 * — 앞으로 드로어/헤더 동작을 고치면 여기 한 곳만 고치면 된다.
 *
 * CSS는 app/globals.css의 dash-shell/dash-sidebar/dash-nav-link 등을 그대로 쓴다
 * (이름은 dash-* 지만 도메인 특화 스타일이 아니라 범용 사이드바 셸 스타일이다).
 */

export interface SidebarNavItem {
  label: string;
  href: string;
  icon: string;
  /** false면 링크 대신 '준비중' 배지로 표시한다. 생략 시 true. */
  ready?: boolean;
}

const navIconStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "20px",
  fontSize: "15px",
  flexShrink: 0,
};

interface SidebarShellProps {
  /** 사이드바 상단 브랜드 블록 (제목/부제/배지 등, 호출부가 구성) */
  brand: ReactNode;
  navGroups: SidebarNavItem[][];
  /**
   * 좁은 화면(.dash-sidebar와 같은 900px 기준)에서 navGroups 대신 보여줄 축약 메뉴.
   * 생략하면 PC와 동일한 navGroups를 그대로 쓴다 — 관리자 화면(admin-shell)처럼
   * 축약이 필요 없는 곳은 그냥 안 넘기면 된다.
   */
  mobileNavGroups?: SidebarNavItem[][];
  /** 어느 메뉴에도 안 걸릴 때(예: 루트 대시보드) 헤더에 보여줄 기본 라벨 */
  fallbackLabel: string;
  /** 사이드바 하단 블록 (표시 이름, 서비스 홈 링크 등) */
  footer: ReactNode;
  /** 상단 헤더 제목 밑에 보여줄 부제 (예: 조직명). 없으면 생략 */
  headerSubtitle?: ReactNode;
  /** 상단 헤더 우측 슬롯 (배지, 로그아웃 버튼 등) */
  headerRight?: ReactNode;
  /** 본문 <main>의 최대 너비. 생략하면 폭 제한 없음(호출부 페이지가 각자 컨테이너로 정함) */
  mainMaxWidth?: string;
  children: ReactNode;
}

const MOBILE_BREAKPOINT_QUERY = "(max-width: 900px)";

export function SidebarShell({
  brand,
  navGroups,
  mobileNavGroups,
  fallbackLabel,
  footer,
  headerSubtitle,
  headerRight,
  mainMaxWidth,
  children,
}: SidebarShellProps) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 서버 렌더는 항상 PC 메뉴로 시작한다 — 뷰포트는 클라이언트에서만 알 수 있어
  // 첫 렌더에 mobileNavGroups를 쓰면 하이드레이션 시점에 깜빡인다.
  const [isMobileViewport, setIsMobileViewport] = useState(false);

  useEffect(() => {
    if (!mobileNavGroups) return;

    const media = window.matchMedia(MOBILE_BREAKPOINT_QUERY);

    setIsMobileViewport(media.matches);
    const onChange = (event: MediaQueryListEvent) => setIsMobileViewport(event.matches);

    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mobileNavGroups]);

  // 모바일 드로어는 경로 이동 시 자동으로 닫는다.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const displayedNavGroups = mobileNavGroups && isMobileViewport ? mobileNavGroups : navGroups;
  // 라벨 조회는 항상 전체 메뉴(navGroups) 기준 — 축약 메뉴에 없는 페이지를 들어가도
  // 헤더 제목이 fallbackLabel로 빠지지 않아야 한다.
  const currentLabel = navGroups.flat().find((item) => isActive(item.href))?.label ?? fallbackLabel;

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
        {brand}

        <nav style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {displayedNavGroups.map((group, groupIndex) => (
            <div key={groupIndex} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {groupIndex > 0 && (
                <div
                  aria-hidden
                  style={{ height: "1px", backgroundColor: "#334155", margin: "6px 10px" }}
                />
              )}
              {group.map((item) =>
                item.ready !== false ? (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="dash-nav-link"
                    data-active={isActive(item.href)}
                  >
                    <span aria-hidden style={navIconStyle}>{item.icon}</span>
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
                    <span aria-hidden style={navIconStyle}>{item.icon}</span>
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
            </div>
          ))}
        </nav>

        {footer}
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
            {headerSubtitle && (
              <div style={{ fontSize: "11px", color: "#64748b" }}>{headerSubtitle}</div>
            )}
          </div>

          {headerRight && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
              {headerRight}
            </div>
          )}
        </header>

        <main style={{ flex: 1, padding: "20px 16px", maxWidth: mainMaxWidth, width: "100%" }}>
          {children}
        </main>
      </div>
    </div>
  );
}
