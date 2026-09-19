"use client";

import { useState, useTransition } from "react";
import { startKakaoLoginAction } from "@/app/actions/buyer-auth";
import { SHOP_MAX_WIDTH } from "./shop-chrome";

interface KakaoLoginGateProps {
  shopToken: string;
  /** 공개 조회로 얻은 공급사 상호 (미등록 링크면 null) */
  businessName: string | null;
  /** 로그인 후 복귀할 내부 경로 */
  returnPath: string;
  /** 콜백에서 전달된 실패 안내 */
  initialError?: string | null;
}

/**
 * 미니샵 로그인 게이트.
 *
 * 알림톡 링크로 들어온 바이어가 최초 1회만 통과하는 화면이다.
 * 카카오 외 채널(문자/이메일/비밀번호)은 제공하지 않는다.
 */
export function KakaoLoginGate({
  shopToken,
  businessName,
  returnPath,
  initialError,
}: KakaoLoginGateProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(initialError ?? null);

  const handleLogin = () => {
    setErrorMessage(null);

    startTransition(async () => {
      const result = await startKakaoLoginAction(shopToken, returnPath);

      if (result.success && result.data?.url) {
        // 카카오 인앱 브라우저 호환을 위해 현재 탭에서 그대로 이동한다.
        window.location.href = result.data.url;

        return;
      }

      setErrorMessage(result.error ?? "카카오 로그인을 시작할 수 없습니다.");
    });
  };

  return (
    <main
      style={{
        maxWidth: SHOP_MAX_WIDTH,
        margin: "0 auto",
        minHeight: "100vh",
        backgroundColor: "#f8fafc",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "24px 20px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          backgroundColor: "#ffffff",
          borderRadius: "16px",
          border: "1px solid #e2e8f0",
          padding: "32px 24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "36px", marginBottom: "14px" }}>🥩</div>

        <h1 style={{ fontSize: "19px", fontWeight: 800, color: "#0f172a", marginBottom: "8px" }}>
          {businessName ? `${businessName} 발주 미니샵` : "발주 미니샵"}
        </h1>

        <p style={{ fontSize: "13px", color: "#475569", lineHeight: 1.7, marginBottom: "24px" }}>
          계약 단가와 시크릿 특가는 <strong>인증된 단골 거래처</strong>에게만 공개됩니다.
          <br />
          카카오 로그인 한 번이면 다음부터는 바로 발주할 수 있습니다.
        </p>

        {errorMessage && (
          <p
            style={{
              fontSize: "12px",
              color: "#b91c1c",
              backgroundColor: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: "8px",
              padding: "10px 12px",
              marginBottom: "16px",
              lineHeight: 1.6,
            }}
          >
            {errorMessage}
          </p>
        )}

        <button
          type="button"
          onClick={handleLogin}
          disabled={isPending}
          style={{
            width: "100%",
            backgroundColor: "#fee500",
            color: "#181600",
            fontWeight: 800,
            fontSize: "15px",
            padding: "15px",
            borderRadius: "10px",
            border: "none",
            cursor: isPending ? "not-allowed" : "pointer",
            opacity: isPending ? 0.7 : 1,
          }}
        >
          {isPending ? "카카오로 이동 중..." : "카카오로 3초 시작하기"}
        </button>

        <p style={{ fontSize: "12px", color: "#475569", lineHeight: 1.6, marginTop: "16px" }}>
          링크가 다른 사람에게 전달되어도 본인의 카카오 계정 없이는 발주 내역을 볼 수 없습니다.
        </p>
      </div>
    </main>
  );
}
