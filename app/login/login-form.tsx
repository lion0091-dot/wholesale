"use client";

import { useState, useTransition, type FormEvent } from "react";
import { signIn } from "@/app/auth/actions";

interface LoginFormProps {
  /** 미들웨어가 붙여준 원래 목적지 (?next=...) — 안내 문구 + 로그인 후 복귀 경로로 사용한다. */
  nextPath?: string;
  /** Supabase 환경변수 미설정(데모 모드) 여부 */
  authDisabled?: boolean;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  fontSize: "15px",
  border: "1px solid #cbd5e1",
  borderRadius: "8px",
  backgroundColor: "#ffffff",
  color: "#0f172a",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: 600,
  color: "#334155",
  marginBottom: "6px",
};

export function LoginForm({ nextPath, authDisabled = false }: LoginFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);

    startTransition(async () => {
      // 로그인 성공 시 signIn()이 역할별 랜딩 경로로 redirect하므로 값이 돌아오지 않는다.
      const result = await signIn(formData);

      if (result && !result.success) {
        setError(result.error ?? "로그인에 실패했습니다.");
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      {nextPath && <input type="hidden" name="next" value={nextPath} />}

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
          }}
        >
          ℹ️ Supabase 환경변수가 설정되지 않은 데모 모드입니다. 실제 로그인은 동작하지 않으며,
          백오피스는 샘플 데이터로 열람할 수 있습니다.
        </div>
      )}

      <div style={{ marginBottom: "14px" }}>
        <label htmlFor="email" style={labelStyle}>
          이메일
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="supplier@example.com"
          disabled={pending}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: "18px" }}>
        <label htmlFor="password" style={labelStyle}>
          비밀번호
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="비밀번호 입력"
          disabled={pending}
          style={inputStyle}
        />
      </div>

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
          }}
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        style={{
          width: "100%",
          padding: "12px",
          fontSize: "15px",
          fontWeight: 700,
          color: "#ffffff",
          backgroundColor: pending ? "#f87171" : "#dc2626",
          border: "none",
          borderRadius: "8px",
          cursor: pending ? "wait" : "pointer",
        }}
      >
        {pending ? "로그인 중..." : "공급사 백오피스 로그인"}
      </button>
    </form>
  );
}
