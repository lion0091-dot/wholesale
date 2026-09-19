"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface AdminNavLink {
  href: string;
  label: string;
}

// 관련 있는 링크끼리 묶어서 순서를 정한다(2026-09-19) — 예전에는 순서에 별 의미가
// 없어서 청구·구독 관련 3개가 상품 카테고리/입점 리드 사이에 흩어져 있었다.
// ① 온보딩(리드 → 승인) ② 상품 ③ 구독료/매출 ④ 시스템.
const ADMIN_NAV_GROUPS: AdminNavLink[][] = [
  [
    { href: "/admin/retailer-leads", label: "입점 리드" },
    { href: "/admin/suppliers", label: "공급사 승인" },
  ],
  [{ href: "/admin/categories", label: "상품 카테고리" }],
  [
    { href: "/admin/billing", label: "청구·수납" },
    { href: "/admin/stats", label: "구독 추이" },
    { href: "/admin/events", label: "할인 이벤트" },
  ],
  [{ href: "/admin/admins", label: "관리자 관리" }],
];

/**
 * 관리자 화면 공통 상단 내비게이션. 예전에는 페이지마다 밑줄 텍스트 링크를 한 줄로
 * 죽 늘어놓아서(플랫폼 슈퍼 관리자 배지 + 5~7개 링크) 줄바꿈 없이 가로로 넘치거나
 * 지저분해 보였다 — 탭 형태 pill 버튼 + flexWrap으로 정리했다.
 *
 * "관리자 관리" 링크는 승격 권한(can_grant)이 없는 계정도 항상 보이지만, 그 페이지
 * 자체(requireAdminGranter)가 접근을 막고 redirect하므로 여기서 따로 숨길 필요는 없다.
 */
export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flexWrap: "wrap",
        marginBottom: "10px",
      }}
    >
      <span
        style={{
          fontSize: "11px",
          fontWeight: 700,
          color: "#dc2626",
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "6px",
          padding: "5px 8px",
        }}
      >
        슈퍼 관리자
      </span>
      <Link
        href="/"
        style={{
          fontSize: "12px",
          fontWeight: 600,
          color: "#94a3b8",
          textDecoration: "none",
          padding: "5px 4px",
        }}
      >
        ← 메인 허브
      </Link>
      {ADMIN_NAV_GROUPS.map((group, groupIndex) => (
        <div key={groupIndex} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {groupIndex > 0 && (
            <span
              aria-hidden
              style={{ width: "1px", height: "16px", backgroundColor: "#e2e8f0", margin: "0 2px" }}
            />
          )}
          {group.map((link) => {
            const active = pathname === link.href;

            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  color: active ? "#ffffff" : "#334155",
                  backgroundColor: active ? "#0f172a" : "#f1f5f9",
                  border: `1px solid ${active ? "#0f172a" : "#cbd5e1"}`,
                  borderRadius: "6px",
                  padding: "5px 10px",
                  textDecoration: "none",
                }}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
