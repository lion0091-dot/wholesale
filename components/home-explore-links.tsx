"use client";

import { useState } from "react";

interface HomeExploreLinksProps {
  showAdminEntry: boolean;
}

/**
 * 대문 하단 "둘러보기" 접이식 섹션 — 개발/데모용 내부 대시보드 바로가기.
 * 슈퍼 관리자 링크 노출 여부는 서버(app/page.tsx)가 DB 권한으로 미리 판정해
 * 내려준다 — 이 컴포넌트는 그 값을 그대로 쓸 뿐 자체적으로 권한 판단을 하지 않는다.
 */
export function HomeExploreLinks({ showAdminEntry }: HomeExploreLinksProps) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: "28px", textAlign: "center" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          fontSize: "12px",
          color: "#94a3b8",
          background: "none",
          border: "none",
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        {open ? "둘러보기 접기 ▲" : "둘러보기 (데모 화면) ▼"}
      </button>

      {open && (
        <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <a href="/dashboard/products" style={{ fontSize: "12px", color: "#64748b" }}>
            도매업자 상품 관리 대시보드 →
          </a>
          <a href="/shop/demo-token-12345" style={{ fontSize: "12px", color: "#64748b" }}>
            고객(소매) 전용 모바일 미니샵 (카톡 초대 링크 체험) →
          </a>
          <a href="/dashboard/orders" style={{ fontSize: "12px", color: "#64748b" }}>
            도매업자 발주 접수 관리 대시보드 →
          </a>
          {showAdminEntry && (
            <a href="/admin/suppliers" style={{ fontSize: "12px", color: "#64748b" }}>
              플랫폼 슈퍼 관리자 →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
