"use client";

import { useWebPush } from "@/lib/hooks/use-web-push";

/**
 * 종 패널 맨 위 "이 폰으로 알림 받기" 한 줄. 켜면 이 브라우저가 새 주문·주문 수정·취소 요청·여신 초과 알림을
 * 화면이 꺼져 있어도 받는다(웹푸시). 켜고 끄는 건 브라우저 하나 단위다 — 폰·PC 각각 켜야 한다.
 */
export function PushToggle({ configured }: { configured: boolean }) {
  const { enabled, state, error, enable, disable } = useWebPush(configured);

  if (!enabled || state === "checking" || state === "unsupported") return null;

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
    margin: "0 4px 4px",
    padding: "8px 6px 10px",
    borderBottom: "1px solid #e2e8f0",
    fontSize: "12px",
    color: "#334155",
  };

  const buttonStyle: React.CSSProperties = {
    flexShrink: 0,
    border: "1px solid #bfdbfe",
    borderRadius: "6px",
    padding: "4px 10px",
    fontSize: "12px",
    fontWeight: 700,
    color: "#2563eb",
    backgroundColor: "#ffffff",
    cursor: "pointer",
  };

  if (state === "ios-install") {
    return (
      <div style={rowStyle}>
        <span>
          아이폰은 <strong>홈 화면에 추가</strong>한 앱에서만 알림을 켤 수 있습니다. 사파리 공유 버튼 → &quot;홈 화면에 추가&quot;.
        </span>
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div style={rowStyle}>
        <span>이 브라우저에서 알림이 차단돼 있습니다. 주소창 옆 자물쇠(설정)에서 알림을 허용한 뒤 다시 열어주세요.</span>
      </div>
    );
  }

  return (
    <div style={rowStyle}>
      <span>
        {state === "on" ? (
          <>
            <strong style={{ color: "#166534" }}>이 기기로 알림 받는 중</strong> — 새 주문·취소 요청이 화면이 꺼져 있어도 옵니다
          </>
        ) : (
          <>
            <strong>이 기기로 알림 받기</strong> — 새 주문·취소 요청을 화면이 꺼져 있어도 받습니다
          </>
        )}
        {error && <div style={{ color: "#b91c1c", marginTop: "2px" }}>{error}</div>}
      </span>
      <button type="button" onClick={state === "on" ? disable : enable} disabled={state === "busy"} style={buttonStyle}>
        {state === "busy" ? "…" : state === "on" ? "끄기" : "켜기"}
      </button>
    </div>
  );
}
