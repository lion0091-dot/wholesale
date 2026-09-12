"use client";

import { useState, useTransition } from "react";
import { startSupplierKakaoLoginAction } from "@/app/actions/supplier-auth";

interface KakaoLoginPanelProps {
  /** 미들웨어가 붙여준 원래 목적지 (?next=...) — 로그인 후 복귀 경로 */
  nextPath?: string;
  /** Supabase 환경변수 미설정(데모 모드) 여부 */
  authDisabled?: boolean;
  /** 콜백에서 전달된 실패 안내 */
  initialError?: string | null;
}

/**
 * 공급사 로그인/가입 게이트.
 *
 * 로그인과 가입이 같은 버튼이다. 카카오 계정이 처음이면 그대로 가입되고,
 * 최소 정보(약관 동의 + 연락처 + 상호) 입력 화면으로 이어진다.
 */
export function KakaoLoginPanel({
  nextPath,
  authDisabled = false,
  initialError,
}: KakaoLoginPanelProps) {
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [pending, startTransition] = useTransition();

  const handleLogin = () => {
    setError(null);

    startTransition(async () => {
      const result = await startSupplierKakaoLoginAction(nextPath);

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
      {nextPath && !error && (
        <div
          style={{
            backgroundColor: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e40af",
            fontSize: "13px",
            padding: "10px 12px",
            borderRadius: "8px",
            marginBottom: "16px",
            lineHeight: 1.6,
          }}
        >
          로그인이 필요한 페이지입니다. 로그인 후 요청하신 화면으로 이동합니다.
        </div>
      )}

      {authDisabled && (
        <div
          style={{
            backgroundColor: "#fef3c7",
            border: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "13px",
            padding: "10px 12px",
            borderRadius: "8px",
            marginBottom: "16px",
            lineHeight: 1.6,
          }}
        >
          ℹ️ Supabase 환경변수가 설정되지 않은 데모 모드입니다. 실제 로그인은 동작하지 않으며,
          백오피스는 샘플 데이터로 열람할 수 있습니다.
        </div>
      )}

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
        disabled={pending || authDisabled}
        style={{
          width: "100%",
          backgroundColor: "#fee500",
          color: "#181600",
          fontWeight: 800,
          fontSize: "15px",
          padding: "15px",
          borderRadius: "10px",
          border: "none",
          cursor: pending || authDisabled ? "not-allowed" : "pointer",
          opacity: pending || authDisabled ? 0.7 : 1,
        }}
      >
        {pending ? "카카오로 이동 중..." : "카카오로 3초 시작하기"}
      </button>

      <p style={{ fontSize: "12px", color: "#64748b", lineHeight: 1.7, marginTop: "14px" }}>
        처음 접속하는 카카오 계정이면 그대로 가입이 진행됩니다. 이어지는 화면에서 약관 동의와
        상호·연락처만 입력하면 <strong>승인 대기 없이 바로</strong> 상품 등록과 발주 관리를
        시작할 수 있습니다.
      </p>
    </div>
  );
}
