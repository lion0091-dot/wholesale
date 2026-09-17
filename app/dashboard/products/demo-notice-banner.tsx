"use client";

import { useState, type ReactNode } from "react";

/**
 * 데모/미인증 안내 문구가 길어 모바일에서 스크롤 부담을 준다는 지적으로 접이식으로 바꿈.
 * 핵심 CTA(기본 납품 품목 불러오기 버튼)는 접힘 상태와 무관하게 항상 보인다.
 */
export function DemoNoticeBanner({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        backgroundColor: "#fef3c7",
        border: "1px solid #fde68a",
        color: "#92400e",
        borderRadius: "8px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "12px 16px",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          border: "none",
          background: "none",
          padding: 0,
          fontSize: "13px",
          fontWeight: 700,
          color: "#92400e",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span>ℹ️ 샘플 상품을 표시하고 있습니다</span>
        <span aria-hidden style={{ fontSize: "11px" }}>{expanded ? "접기 ▾" : "자세히 ▸"}</span>
      </button>

      {expanded && (
        <p style={{ fontSize: "13px", lineHeight: 1.7, margin: 0 }}>
          등록된 상품이 없거나 미인증(데모) 상태여서 샘플 상품을 표시하고 있습니다. 샘플 행의
          저장/삭제는 동작하지 않습니다. 아래 버튼으로 기본 납품 품목을 실제 상품으로 한 번에
          등록하면 미니샵에 바로 노출됩니다.
        </p>
      )}

      {children}
    </div>
  );
}
