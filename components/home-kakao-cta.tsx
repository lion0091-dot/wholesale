"use client";

import { useState, useTransition } from "react";
import { startSupplierKakaoLoginAction } from "@/app/actions/supplier-auth";

interface HomeKakaoCtaProps {
  /** Supabase 환경변수 미설정(데모 모드) 여부 */
  authDisabled?: boolean;
}

/**
 * 대문의 공급사 가입/로그인 CTA.
 *
 * 예전엔 /login 페이지로 이동만 하는 링크였고, 거기서 다시 버튼을 눌러야
 * 카카오 인증이 시작됐다(대문 클릭 → /login 클릭 → 카카오 화면, 총 3단계).
 * 대문에서 바로 카카오 인증을 시작해 한 단계를 없앤다.
 */
export function HomeKakaoCta({ authDisabled = false }: HomeKakaoCtaProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    setError(null);

    startTransition(async () => {
      const result = await startSupplierKakaoLoginAction();

      if (result.success && result.data?.url) {
        window.location.href = result.data.url;

        return;
      }

      setError(result.error ?? "카카오 로그인을 시작할 수 없습니다.");
    });
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending || authDisabled}
        style={{
          display: "block",
          width: "100%",
          backgroundColor: "#fee500",
          color: "#181600",
          padding: "13px 16px",
          borderRadius: "8px",
          fontWeight: 800,
          fontSize: "14px",
          textAlign: "center",
          border: "none",
          cursor: pending || authDisabled ? "not-allowed" : "pointer",
          opacity: pending || authDisabled ? 0.7 : 1,
        }}
      >
        {pending ? "카카오로 이동 중..." : "카카오로 3초 가입 / 로그인 →"}
      </button>

      {authDisabled && (
        <p style={{ fontSize: "12px", color: "#92400e", marginTop: "8px", lineHeight: 1.6 }}>
          Supabase 환경변수가 설정되지 않은 데모 모드라 로그인은 동작하지 않습니다.
        </p>
      )}

      {error && (
        <p role="alert" style={{ fontSize: "12px", color: "#991b1b", marginTop: "8px", lineHeight: 1.6 }}>
          {error}
        </p>
      )}
    </div>
  );
}
