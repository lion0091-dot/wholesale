import Link from "next/link";

export function LegalFooter() {
  return (
    <footer
      style={{
        backgroundColor: "#0f172a",
        color: "#94a3b8",
        padding: "36px 20px 48px",
        fontSize: "12px",
        lineHeight: "1.7",
        borderTop: "1px solid #1e293b",
        marginTop: "auto",
      }}
    >
      <div style={{ maxWidth: "768px", margin: "0 auto" }}>
        {/* 상단 약관 및 고객지원 링크 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "16px",
            marginBottom: "16px",
            paddingBottom: "16px",
            borderBottom: "1px solid #1e293b",
            fontWeight: 600,
          }}
        >
          <Link href="/terms" style={{ color: "#f8fafc", textDecoration: "none" }}>
            서비스 이용약관
          </Link>
          <span style={{ color: "#334155" }}>|</span>
          <Link href="/privacy" style={{ color: "#f8fafc", textDecoration: "none" }}>
            개인정보처리방침
          </Link>
          <span style={{ color: "#334155" }}>|</span>
          <a href="mailto:support@wholesale-meat.kr" style={{ color: "#cbd5e1", textDecoration: "none" }}>
            고객센터 문의
          </a>
        </div>

        {/* 법적 사업자 정보 고지 (전자상거래법 준수) */}
        <div style={{ marginBottom: "16px" }}>
          <p style={{ fontWeight: 700, color: "#cbd5e1", marginBottom: "4px" }}>
            (주)미트체인 플랫폼사업본부
          </p>
          <p>
            대표자: 홍길동 | 사업자등록번호: 220-88-00000 | 통신판매업신고: 제 2026-서울성동-00000호
          </p>
          <p>
            주소: 서울특별시 성동구 마장로 123 미트타워 5층 | 개인정보보호책임자: 이순신 (privacy@wholesale-meat.kr)
          </p>
          <p>
            고객지원센터: 1588-0000 (평일 09:00 ~ 18:00, 토/일/공휴일 휴무)
          </p>
        </div>

        {/* 통신판매중개자 고지 및 에스크로 결제 안전 고지 */}
        <div
          style={{
            backgroundColor: "#1e293b",
            padding: "12px 16px",
            borderRadius: "8px",
            fontSize: "11px",
            color: "#64748b",
            lineHeight: "1.6",
            marginBottom: "16px",
          }}
        >
          <p style={{ color: "#94a3b8", fontWeight: 600, marginBottom: "4px" }}>
            🛡️ 구매안전(에스크로) 서비스 및 중개 고지
          </p>
          <p>
            (주)미트체인은 각 개별 육류 도매업체와 바이어(구매 회원) 간의 주문 중개 시스템을 제공하며, 통신판매의 당사자가 아닙니다. 상품의 등록, 재고, 단가, 품질 및 배송에 대한 일체의 법적 책임은 해당 도매 판매업체에 있습니다.
          </p>
          <p style={{ marginTop: "4px" }}>
            구매자의 안전한 거래를 위하여 본 플랫폼을 통한 전자상거래 결제 시 관련 법령에 따른 에스크로 구매안전서비스를 적용합니다.
          </p>
        </div>

        <p style={{ fontSize: "11px", color: "#475569", textAlign: "center" }}>
          © 2026 MeatChain Platform. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
