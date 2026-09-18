import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import {
  SUPPLIER_LANDING_PATH,
  SUPPLIER_ONBOARDING_PATH,
  sanitizeSupplierReturnPath,
} from "@/lib/auth/supplier-auth";
import { getSupplierAccount } from "@/lib/supplier/verification";
import { getLandingPathForRole } from "@/lib/auth/session";
import { KakaoLoginPanel } from "./kakao-login-panel";

export const metadata: Metadata = {
  title: "공급사 로그인 | 미트 파트너스",
  description: "카카오 3초 로그인으로 시작하는 도매(공급사) 백오피스",
};

interface LoginPageProps {
  searchParams: Promise<{ next?: string; auth_error?: string; auth_message?: string }>;
}

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "24px 20px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
};

/**
 * 공급사 로그인/가입 — 카카오 단일 채널.
 *
 * 이메일/비밀번호 화면은 폐기했다. 계정은 더 이상 플랫폼 관리자가 선발급하지 않고,
 * 공급사가 직접 카카오로 가입한 뒤 최소 정보만 입력하면 즉시 사용을 시작한다.
 * (행정 승인 전에는 '초대장 발부'만 잠긴다)
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { next, auth_message: authMessage } = await searchParams;

  // 오픈 리다이렉트 방지: 내부 절대 경로만 허용한다.
  const nextPath = sanitizeSupplierReturnPath(next) ?? undefined;
  const authEnabled = isSupabaseConfigured();

  // 이미 로그인된 계정이 로그인 화면에 머무르면 백오피스에 못 들어간 것처럼 보인다.
  if (authEnabled) {
    const account = await getSupplierAccount();

    if (account) {
      if (account.needsMinimumInfo) {
        redirect(SUPPLIER_ONBOARDING_PATH);
      }

      redirect(
        nextPath ??
          (account.isSupplier
            ? SUPPLIER_LANDING_PATH
            : getLandingPathForRole(account.platformRole))
      );
    }
  }

  return (
    <main style={{ maxWidth: "420px", margin: "0 auto", padding: "56px 20px 40px" }}>
      <header style={{ textAlign: "center", marginBottom: "28px" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "#dc2626" }}>공급사(도매) 전용</span>
        <h1 style={{ fontSize: "24px", fontWeight: 800, color: "#0f172a", margin: "6px 0 8px" }}>
          카카오로 3초 가입
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          상품·단가·발주 관리를 위한 도매업체 관리자 화면입니다.
          <br />
          고객(소매)는 전달받은 전용 초대 링크로 접속해 주세요.
        </p>
      </header>

      <section style={cardStyle}>
        <KakaoLoginPanel
          nextPath={nextPath}
          authDisabled={!authEnabled}
          initialError={authMessage ?? null}
        />
      </section>

      <section
        style={{
          ...cardStyle,
          marginTop: "14px",
          backgroundColor: "#f8fbff",
          borderColor: "#bfdbfe",
        }}
      >
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#1e40af", marginBottom: "8px" }}>
          가입 후 바로 되는 것 / 승인 후 되는 것
        </div>
        <ul
          style={{
            margin: 0,
            paddingLeft: "18px",
            fontSize: "12px",
            color: "#475569",
            lineHeight: 1.8,
          }}
        >
          <li>즉시 이용: 상품 등록, 맞춤 단가, 발주 접수, 마이페이지</li>
          <li>승인 후 이용: 고객(소매) 초대장 발부 (사업자 검증 등 행정 절차 완료 시 활성화)</li>
        </ul>
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
        <Link href="/terms" style={{ color: "#2563eb", textDecoration: "underline" }}>
          이용약관
        </Link>
        {" · "}
        <Link href="/privacy" style={{ color: "#2563eb", textDecoration: "underline" }}>
          개인정보처리방침
        </Link>
        <br />
        <Link href="/" style={{ color: "#2563eb", textDecoration: "underline" }}>
          홈으로 돌아가기
        </Link>
      </p>
    </main>
  );
}
