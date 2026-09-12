import { isSupabaseConfigured } from "@/lib/supabase/middleware";
import { isSuperAdminSession } from "@/lib/auth/rbac";

export default async function Home() {
  // 슈퍼관리자 콘솔 진입 버튼은 DB 권한(profiles.role)이 있을 때만 노출한다.
  // 라우트 자체는 미들웨어와 라우트 가드가 이중으로 막지만, 버튼을 숨겨
  // 일반 사용자에게 관리자 콘솔의 존재를 알리지 않는다.
  // 데모 모드(Supabase 미설정)에서는 시연을 위해 그대로 보여준다.
  const showAdminEntry = !isSupabaseConfigured() || (await isSuperAdminSession());

  return (
    <main style={{ padding: "40px 20px", maxWidth: "600px", margin: "0 auto" }}>
      <header style={{ marginBottom: "32px", textAlign: "center" }}>
        <h1 style={{ fontSize: "24px", fontWeight: "bold", color: "#b91c1c", marginBottom: "8px" }}>
          미트 파트너스
        </h1>
        <p style={{ color: "#64748b", fontSize: "14px" }}>
          폐쇄형 1:1 도매업자 - 바이어(구매 회원) 모바일 발주 솔루션
        </p>
      </header>

      <section style={{ background: "#ffffff", padding: "24px", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <h2 style={{ fontSize: "18px", fontWeight: 600, marginBottom: "12px" }}>시스템 안내</h2>
        <p style={{ fontSize: "14px", lineHeight: "1.6", color: "#334155", marginBottom: "16px" }}>
          본 시스템은 오픈 마켓이 아니며, 도매업체로부터 전달받으신 <strong>전용 초대 링크</strong>를 통해서만 접속 가능한 비공개 플랫폼입니다.
        </p>

        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
          <a
            href="/login"
            style={{
              display: "inline-block",
              backgroundColor: "#fee500",
              color: "#181600",
              padding: "12px 16px",
              borderRadius: "8px",
              fontWeight: 800,
              fontSize: "14px",
              textAlign: "center",
            }}
          >
            공급사(도매) 카카오로 3초 가입 / 로그인 →
          </a>

          <a
            href="/dashboard/products"
            style={{
              display: "inline-block",
              backgroundColor: "#dc2626",
              color: "#ffffff",
              padding: "10px 16px",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "14px",
              textAlign: "center",
            }}
          >
            1. 도매업자 상품 관리 대시보드 →
          </a>

          <a
            href="/shop/demo-token-12345"
            style={{
              display: "inline-block",
              backgroundColor: "#0f172a",
              color: "#ffffff",
              padding: "10px 16px",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "14px",
              textAlign: "center",
            }}
          >
            2. 바이어 전용 모바일 미니샵 (카톡 초대 링크 체험) →
          </a>

          <a
            href="/dashboard/orders"
            style={{
              display: "inline-block",
              backgroundColor: "#2563eb",
              color: "#ffffff",
              padding: "10px 16px",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "14px",
              textAlign: "center",
            }}
          >
            3. 도매업자 발주 접수 관리 대시보드 →
          </a>

          {showAdminEntry && (
            <a
              href="/admin/suppliers"
              style={{
                display: "inline-block",
                backgroundColor: "#475569",
                color: "#ffffff",
                padding: "10px 16px",
                borderRadius: "8px",
                fontWeight: 600,
                fontSize: "14px",
                textAlign: "center",
              }}
            >
              4. 플랫폼 슈퍼 관리자 (공급사 승인 / 구독 관리) →
            </a>
          )}
        </div>
      </section>
    </main>
  );
}
