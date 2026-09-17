"use client";

import { useState } from "react";

/**
 * 테스트/스테이징 환경 안내 배너.
 * NEXT_PUBLIC_IS_LIVE=true 를 명시적으로 설정한 배포(실제 오픈 시점)에서만 숨겨진다.
 * 안전한 기본값: 값이 없으면(로컬/스테이징) 항상 노출.
 * 테스트 기간 중에도 매번 화면 공간을 차지하는 게 불편할 수 있어 닫기 버튼을 둔다
 * (세션 중 상태만 — 새로고침하면 다시 보임. 실제 오픈 후엔 애초에 렌더링 자체가 안 됨).
 */
const isLive = process.env.NEXT_PUBLIC_IS_LIVE === "true";

export function StagingBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (isLive || dismissed) {
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        backgroundColor: "#fde047",
        color: "#713f12",
        textAlign: "center",
        padding: "6px 8px 6px 12px",
        fontSize: "12px",
        fontWeight: 700,
        lineHeight: 1.4,
      }}
    >
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        ⚠️ 테스트 환경 — 데이터가 예고 없이 초기화될 수 있습니다.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="배너 닫기"
        style={{
          border: "none",
          background: "none",
          color: "#713f12",
          fontSize: "16px",
          fontWeight: 700,
          lineHeight: 1,
          padding: "2px 4px",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
