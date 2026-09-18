import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";
import { RetailerLeadSection } from "@/components/retailer-lead-section";
import { HomeExploreLinks } from "@/components/home-explore-links";
import { HomeKakaoCta } from "@/components/home-kakao-cta";

const cardStyle: React.CSSProperties = {
  background: "#ffffff",
  padding: "24px",
  borderRadius: "12px",
  border: "1px solid #e2e8f0",
  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
};

export default async function Home() {
  const authEnabled = isSupabaseConfigured();

  // 슈퍼관리자 콘솔 링크는 DB 권한(profiles.role)이 있을 때만 노출한다.
  // 라우트 자체는 미들웨어와 라우트 가드가 이중으로 막지만, 일반 방문자에게는
  // 관리자 콘솔의 존재를 알리지 않는다. 데모 모드(Supabase 미설정)에서는 시연을 위해 노출.
  const showAdminEntry = !authEnabled || (await isSuperAdminSession());

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

      {/* 서비스 흐름 요약 */}
      <section style={{ ...cardStyle, marginBottom: "16px" }}>
        <h2 style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a", marginBottom: "14px" }}>
          이렇게 진행돼요
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#b91c1c", marginBottom: "6px" }}>
              공급사(도매)
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
                color: "#334155",
              }}
            >
              <span>카카오 가입</span>
              <span style={{ color: "#cbd5e1" }}>→</span>
              <span>상품 등록</span>
              <span style={{ color: "#cbd5e1" }}>→</span>
              <span>거래처 초대 링크 발급</span>
              <span style={{ color: "#cbd5e1" }}>→</span>
              <span>발주 접수·출고</span>
            </div>
          </div>

          <div>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a", marginBottom: "6px" }}>
              고객(소매)
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "6px",
                fontSize: "12px",
                color: "#334155",
              }}
            >
              <span>초대 링크로 카카오 로그인</span>
              <span style={{ color: "#cbd5e1" }}>→</span>
              <span>미니샵에서 발주</span>
              <span style={{ color: "#cbd5e1" }}>→</span>
              <span>알림톡으로 진행상황 확인</span>
            </div>
          </div>
        </div>
      </section>

      {/* 공급사(도매) */}
      <section style={{ ...cardStyle, marginBottom: "16px" }}>
        <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a", marginBottom: "6px" }}>
          공급사(도매)이신가요?
        </h2>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6, marginBottom: "14px" }}>
          카카오 계정으로 3초 만에 가입하고, 거래처(고객)에 미니샵 링크를 발급해
          모바일로 발주를 받아보세요.
        </p>
        <HomeKakaoCta authDisabled={!authEnabled} />
      </section>

      {/* 구독료 안내 */}
      <section id="subscription" style={{ ...cardStyle, marginBottom: "16px" }}>
        <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a", marginBottom: "6px" }}>
          구독료 안내
        </h2>
        <p style={{ fontSize: "13px", color: "#64748b", lineHeight: 1.6, marginBottom: "14px" }}>
          가입 후 30일은 무료로 체험하실 수 있습니다. 이후에는 그 달에 실제로 발주가 있었던
          거래처(고객) 수에 비례해 매월 구독료가 발생하며, 거래처가 많아질수록 구간별로
          단가가 낮아지는 게 아니라 <strong>그 구간만큼만</strong> 다음 단가가 적용됩니다
          (구간이 올라가도 이전 구간 단가는 그대로 유지).
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {[
            { range: "1 ~ 50곳", price: "거래처당 5,000원" },
            { range: "51 ~ 100곳", price: "거래처당 7,000원" },
            { range: "101곳 이상", price: "거래처당 9,000원" },
          ].map((tier) => (
            <div
              key={tier.range}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "13px",
                padding: "9px 12px",
                borderRadius: "8px",
                backgroundColor: "#f8fafc",
                border: "1px solid #e2e8f0",
              }}
            >
              <span style={{ color: "#334155", fontWeight: 600 }}>{tier.range}</span>
              <span style={{ color: "#0f172a", fontWeight: 700 }}>{tier.price}</span>
            </div>
          ))}
        </div>

        <p style={{ fontSize: "12px", color: "#94a3b8", marginTop: "10px", lineHeight: 1.6 }}>
          예) 이번 달 발주한 거래처 60곳 = 50곳 × 5,000원 + 10곳 × 7,000원 = 320,000원/월.
          발주가 없었던 거래처는 과금 대상에서 제외됩니다.
        </p>
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
