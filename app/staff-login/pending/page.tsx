import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "승인 대기 | 미트 파트너스",
};

/**
 * 스태프 로그인 직후 도착하는 중립 안내 화면.
 *
 * 이 화면은 세션을 검사하지 않는다 — 로그인 여부와 무관하게 누가 봐도 안전한
 * 정적 안내문뿐이라(개인정보/기능 노출 없음), 별도 가드가 필요 없다.
 * 승인되면 다음 로그인에서 /auth/callback이 getLandingPathForRole("super_admin")로
 * 바로 보내므로 이 화면으로는 다시 오지 않는다.
 */
export default function StaffPendingPage() {
  return (
    <main
      style={{
        maxWidth: "420px",
        margin: "0 auto",
        padding: "72px 20px 40px",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", marginBottom: "12px" }}>
        요청이 접수되었습니다
      </h1>
      <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.7 }}>
        로그인이 확인되었습니다. 운영팀이 확인 후 관리자 권한을 부여하면
        다음 로그인부터 관리자 화면으로 바로 이동합니다. 이 화면에서 따로
        진행할 작업은 없습니다.
      </p>
      <Link
        href="/"
        style={{
          display: "inline-block",
          marginTop: "20px",
          fontSize: "13px",
          color: "#2563eb",
          textDecoration: "underline",
        }}
      >
        홈으로 돌아가기
      </Link>
    </main>
  );
}
