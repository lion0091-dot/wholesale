import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { RetailerLeadSection } from "@/components/retailer-lead-section";
import { HomeExploreLinks } from "@/components/home-explore-links";

const cardStyle: React.CSSProperties = {
  background: "#ffffff",
  padding: "24px",
  borderRadius: "12px",
  border: "1px solid #e2e8f0",
  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
};

export default async function Home() {
  // 슈퍼관리자 콘솔 링크는 DB 권한(profiles.role)이 있을 때만 노출한다.
  // 라우트 자체는 미들웨어와 라우트 가드가 이중으로 막지만, 일반 방문자에게는
  // 관리자 콘솔의 존재를 알리지 않는다. 데모 모드(Supabase 미설정)에서는 시연을 위해 노출.
  const showAdminEntry = !isSupabaseConfigured() || (await isSuperAdminSession());

  return (
    <main style={{ padding: "40px 20px", maxWidth: "600px", margin: "0 auto" }}>
      <header style={{ marginBottom: "28px", textAlign: "center" }}>
        <h1 style={{ fontSize: "26px", fontWeight: "bold", color: "#b91c1c", marginBottom: "10px" }}>
          미트 파트너스
        </h1>
        <p style={{ color: "#334155", fontSize: "15px", lineHeight: 1.7 }}>
          축산물 공급사(도매)와 고객(소매)을 연결하는
          <br />
          폐쇄형 B2B 발주 플랫폼입니다.
        </p>
        <p style={{ color: "#64748b", fontSize: "13px", marginTop: "10px", lineHeight: 1.7 }}>
          오픈 마켓이 아닙니다 — 입점 공급사(도매)는 사업자등록증·국세청 진위확인을 거쳐
          검수되고, 고객(소매)은 공급사(도매)의 초대를 통해서만 발주할 수 있습니다.
        </p>
      </header>

      {/* 공급사(도매) */}
      <section style={{ ...cardStyle, marginBottom: "16px" }}>
        <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a", marginBottom: "6px" }}>
          공급사(도매)이신가요?
        </h2>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6, marginBottom: "14px" }}>
          카카오 계정으로 3초 만에 가입하고, 거래처(고객)에 미니샵 링크를 발급해
          모바일로 발주를 받아보세요.
        </p>
        <a
          href="/login"
          style={{
            display: "block",
            backgroundColor: "#fee500",
            color: "#181600",
            padding: "13px 16px",
            borderRadius: "8px",
            fontWeight: 800,
            fontSize: "14px",
            textAlign: "center",
          }}
        >
          카카오로 3초 가입 / 로그인 →
        </a>
      </section>

      {/* 고객(소매) */}
      <section style={cardStyle}>
        <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a", marginBottom: "6px" }}>
          고객(소매)이신가요?
        </h2>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6, marginBottom: "14px" }}>
          거래 중인 공급사(도매)가 없거나 새로 찾고 계신가요? 입점 희망을 신청해주시면
          담당자가 검토 후 적합한 공급사(도매)를 찾아 직접 연락드립니다.
        </p>

        <RetailerLeadSection />
      </section>

      <HomeExploreLinks showAdminEntry={showAdminEntry} />
    </main>
  );
}
