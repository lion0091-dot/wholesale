import Link from "next/link";
import type { Metadata } from "next";
import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { StaffKakaoLoginPanel } from "./staff-kakao-login-panel";

export const metadata: Metadata = {
  title: "내부 스태프 로그인 | 미트 파트너스",
  description: "플랫폼 운영팀 전용 로그인. 공개 UI에 노출되지 않으며 사내 링크로만 공유합니다.",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "24px 20px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
};

/**
 * 내부 스태프 로그인 — 공급사 가입 화면(app/login)과 다른 도착지로 보내기 위한
 * 별도 진입점. 이 페이지 자체는 아무 권한도 주지 않는다: 로그인만 시키고
 * /auth/callback?intent=staff가 STAFF_PENDING_PATH로 보낸다. 실제 승격은
 * /admin/admins에서 can_grant 보유 관리자가 수행해야 한다.
 */
export default function StaffLoginPage() {
  const authEnabled = isSupabaseConfigured();

  return (
    <main style={{ maxWidth: "420px", margin: "0 auto", padding: "56px 20px 40px" }}>
      <header style={{ textAlign: "center", marginBottom: "28px" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "#dc2626" }}>운영팀 전용</span>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", margin: "6px 0 8px" }}>
          내부 스태프 로그인
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          공급사 가입 화면이 아닙니다. 카카오 로그인 후 운영팀이 확인하여
          별도로 관리자 권한을 부여합니다.
        </p>
      </header>

      <section style={cardStyle}>
        {authEnabled ? (
          <StaffKakaoLoginPanel />
        ) : (
          <p style={{ fontSize: "13px", color: "#92400e", lineHeight: 1.6 }}>
            Supabase 환경변수가 설정되지 않은 데모 모드입니다. 실제 로그인은 동작하지 않습니다.
          </p>
        )}
      </section>

      <p
        style={{
          marginTop: "18px",
          fontSize: "12px",
          color: "#64748b",
          textAlign: "center",
        }}
      >
        <Link href="/" style={{ color: "#2563eb", textDecoration: "underline" }}>
          홈으로 돌아가기
        </Link>
      </p>
    </main>
  );
}
