import { createClient } from "@/lib/supabase/server";
import { JoinTeamKakaoPanel } from "./join-team-kakao-panel";

export const metadata = {
  title: "직원 초대 | 미트 파트너스",
};

interface JoinTeamPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ auth_message?: string }>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mainStyle: React.CSSProperties = {
  maxWidth: "420px",
  margin: "0 auto",
  padding: "56px 20px 40px",
};

const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "24px 20px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
};

/**
 * 공급사(도매업체) 직원 초대 링크 수락 화면.
 *
 * 이메일 없이 카카오 OAuth만으로 조직에 합류하는 초대 링크(app/actions/organization.ts의
 * createStaffInviteAction) — 바이어 shop_token 초대 링크와 같은 원리다. 로그인 전에도
 * get_staff_invite_info() RPC(익명 실행 허용)로 "OO 업체에 합류하기" 정도만 미리 보여준다.
 */
export default async function JoinTeamPage({ params, searchParams }: JoinTeamPageProps) {
  const { token } = await params;
  const { auth_message: authMessage } = await searchParams;

  if (!UUID_PATTERN.test(token)) {
    return (
      <main style={mainStyle}>
        <section style={cardStyle}>
          <p style={{ fontSize: "14px", color: "#991b1b" }}>유효하지 않은 초대 링크입니다.</p>
        </section>
      </main>
    );
  }

  const supabase = await createClient();
  const { data } = await supabase.rpc("get_staff_invite_info", { p_token: token });
  const info = data as { valid?: boolean; organization_name?: string } | null;

  if (!info?.valid) {
    return (
      <main style={mainStyle}>
        <section style={cardStyle}>
          <p style={{ fontSize: "14px", color: "#991b1b", lineHeight: 1.7 }}>
            유효하지 않거나 만료된 초대 링크입니다. 초대한 담당자에게 새 링크를 요청해주세요.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main style={mainStyle}>
      <header style={{ textAlign: "center", marginBottom: "28px" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "#dc2626" }}>직원 초대</span>
        <h1 style={{ fontSize: "22px", fontWeight: 800, color: "#0f172a", margin: "6px 0 8px" }}>
          {info.organization_name}에 합류하기
        </h1>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6 }}>
          카카오 로그인 한 번으로 이 업체의 백오피스에 합류합니다.
        </p>
      </header>

      <section style={cardStyle}>
        <JoinTeamKakaoPanel token={token} initialError={authMessage ?? null} />
      </section>
    </main>
  );
}
