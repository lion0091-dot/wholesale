"use client";

import { useState, useTransition } from "react";
import { startTeamInviteKakaoLoginAction } from "@/app/actions/team-invite";

interface JoinTeamKakaoPanelProps {
  token: string;
  initialError?: string | null;
}

/** 직원 초대 링크 수락 — 로그인과 조직 합류가 같은 버튼이다. */
export function JoinTeamKakaoPanel({ token, initialError }: JoinTeamKakaoPanelProps) {
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [pending, startTransition] = useTransition();

  const handleLogin = () => {
    setError(null);

    startTransition(async () => {
      const result = await startTeamInviteKakaoLoginAction(token);

      if (result.success && result.data?.url) {
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
        {pending ? "카카오로 이동 중..." : "카카오로 합류하기"}
      </button>

      <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.7, marginTop: "14px" }}>
        본인 명의 카카오 계정으로 로그인하면 자동으로 이 업체의 직원으로 등록됩니다. 다른
        업체의 대표·직원이거나 이미 고객(소매)로 가입된 계정은 사용할 수 없습니다.
      </p>
    </div>
  );
}
