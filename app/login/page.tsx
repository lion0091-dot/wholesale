import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import {
  getLandingPathForRole,
  getSessionContext,
  sanitizeNextPath,
} from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "공급사 로그인 | 미트 파트너스",
  description: "도매(공급사) 전용 백오피스 로그인",
};

interface LoginPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { next } = await searchParams;

  // 오픈 리다이렉트 방지: 내부 절대 경로만 허용한다.
  const nextPath = sanitizeNextPath(next) ?? undefined;
  const authEnabled = isSupabaseConfigured();

  // 이미 로그인된 계정이 로그인 화면에 머무르면 백오피스에 못 들어간 것처럼 보인다.
  // 세션이 있으면 원래 목적지 또는 역할별 랜딩 경로로 즉시 보낸다.
  if (authEnabled) {
    const context = await getSessionContext();

    if (context) {
      redirect(nextPath ?? getLandingPathForRole(context.profile?.role));
    }
  }

  return (
    <main
      style={{
        maxWidth: "420px",
        margin: "0 auto",
        padding: "56px 20px 40px",
      }}
    >
      <header style={{ textAlign: "center", marginBottom: "28px" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "#dc2626" }}>
          공급사(도매) 전용
        </span>
        <h1
          style={{
            fontSize: "24px",
            fontWeight: 800,
            color: "#0f172a",
            margin: "6px 0 8px",
          }}
        >
          백오피스 로그인
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          상품·단가·발주 관리를 위한 도매업체 관리자 화면입니다.
          <br />
          바이어(구매 회원)는 전달받은 전용 초대 링크로 접속해 주세요.
        </p>
      </header>

      <section
        style={{
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "12px",
          padding: "24px 20px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
        }}
      >
        <LoginForm nextPath={nextPath} authDisabled={!authEnabled} />
      </section>

      <p
        style={{
          marginTop: "18px",
          fontSize: "12px",
          color: "#64748b",
          textAlign: "center",
          lineHeight: 1.7,
        }}
      >
        계정은 플랫폼 관리자의 업체 승인 후 발급됩니다.
        <br />
        <Link href="/" style={{ color: "#2563eb", textDecoration: "underline" }}>
          홈으로 돌아가기
        </Link>
      </p>
    </main>
  );
}
