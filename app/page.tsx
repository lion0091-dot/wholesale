export default function Home() {
  return (
    <main style={{ padding: "40px 20px", maxWidth: "600px", margin: "0 auto" }}>
      <header style={{ marginBottom: "32px", textAlign: "center" }}>
        <h1 style={{ fontSize: "24px", fontWeight: "bold", color: "#b91c1c", marginBottom: "8px" }}>
          B2B 육류 도매 발주 시스템
        </h1>
        <p style={{ color: "#64748b", fontSize: "14px" }}>
          폐쇄형 1:1 도매업자 - 식당 모바일 발주 솔루션
        </p>
      </header>

      <section style={{ background: "#ffffff", padding: "24px", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
        <h2 style={{ fontSize: "18px", fontWeight: 600, marginBottom: "12px" }}>시스템 안내</h2>
        <p style={{ fontSize: "14px", lineHeight: "1.6", color: "#334155", marginBottom: "16px" }}>
          본 시스템은 오픈 마켓이 아니며, 도매업체로부터 전달받으신 <strong>전용 초대 링크</strong>를 통해서만 접속 가능한 비공개 플랫폼입니다.
        </p>

        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "16px" }}>
          <a
            href="/wholesaler/products"
            style={{
              display: "inline-block",
              backgroundColor: "#dc2626",
              color: "#ffffff",
              padding: "10px 16px",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "14px",
            }}
          >
            도매업자 상품 관리 대시보드 바로가기 →
          </a>
        </div>
      </section>
    </main>
  );
}
