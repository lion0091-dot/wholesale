"use client";

import { useState, useTransition } from "react";
import { startStaffKakaoLoginAction } from "@/app/actions/staff-auth";

/**
 * 내부 스태프 로그인 게이트. app/login/kakao-login-panel.tsx(공급사용)와 버튼
 * 동작은 같지만, nextPath/데모모드 안내 등 공급사 전용 문구를 들고 있지 않다 —
 * 이 화면은 "승인 대기" 하나로만 도착하므로 그런 분기가 필요 없다.
 */
export function StaffKakaoLoginPanel() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleLogin = () => {
    setError(null);

    startTransition(async () => {
      const result = await startStaffKakaoLoginAction();

      if (result.success && result.data?.url) {
        // 카카오 인앱 브라우저 호환을 위해 현재 탭에서 그대로 이동한다.
        window.location.href = result.data.url;

        return;
      }

      setError(result.error ?? "카카오 로그인을 시작할 수 없습니다.");
    });
  };

  return (
    <div>
      {error && (
        <div
          role="alert"
          style={{
            backgroundColor: "#fee2e2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: "13px",
            padding: "10px 12px",
            borderRadius: "8px",
            marginBottom: "14px",
            lineHeight: 1.6,
          }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleLogin}
        disabled={pending}
        style={{
          width: "100%",
          backgroundColor: "#fee500",
          color: "#181600",
          fontWeight: 800,
          fontSize: "15px",
          padding: "15px",
          borderRadius: "10px",
          border: "none",
          cursor: pending ? "not-allowed" : "pointer",
          opacity: pending ? 0.7 : 1,
        }}
      >
        {pending ? "카카오로 이동 중..." : "카카오로 로그인"}
      </button>
    </div>
  );
}
