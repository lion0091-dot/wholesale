import Link from "next/link";

/**
 * 전자상거래법·정보통신망법상 의무 표시 사항을 담는 공통 푸터.
 * 실제 사업자 정보는 환경변수로 주입하고, 미설정 시 플레이스홀더를 노출한다.
 */
const PLATFORM = {
  companyName: process.env.NEXT_PUBLIC_COMPANY_NAME || "(주)미트체인",
  representative: process.env.NEXT_PUBLIC_COMPANY_REPRESENTATIVE || "홍길동",
  businessNumber: process.env.NEXT_PUBLIC_COMPANY_BUSINESS_NUMBER || "220-88-00000",
  mailOrderNumber:
    process.env.NEXT_PUBLIC_COMPANY_MAIL_ORDER_NUMBER || "제 2026-서울성동-00000호",
  address:
    process.env.NEXT_PUBLIC_COMPANY_ADDRESS || "서울특별시 성동구 마장로 123 미트타워 5층",
  privacyOfficer: process.env.NEXT_PUBLIC_PRIVACY_OFFICER || "이순신",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@wholesale-meat.kr",
  privacyEmail: process.env.NEXT_PUBLIC_PRIVACY_EMAIL || "privacy@wholesale-meat.kr",
  supportPhone: process.env.NEXT_PUBLIC_SUPPORT_PHONE || "1588-0000",
  supportHours: process.env.NEXT_PUBLIC_SUPPORT_HOURS || "평일 09:00 ~ 18:00 (토/일/공휴일 휴무)",
};

const linkStyle = { color: "#f8fafc", textDecoration: "none" as const };

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
        {/* 약관 및 고객지원 링크 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px",
            marginBottom: "16px",
            paddingBottom: "16px",
            borderBottom: "1px solid #1e293b",
            fontWeight: 600,
          }}
        >
          <Link href="/terms" style={linkStyle}>
            서비스 이용약관
          </Link>
          <span style={{ color: "#334155" }}>|</span>
          <Link href="/privacy" style={linkStyle}>
            개인정보처리방침
          </Link>
          <span style={{ color: "#334155" }}>|</span>
          <a href={`mailto:${PLATFORM.supportEmail}`} style={{ ...linkStyle, color: "#cbd5e1" }}>
            고객센터 문의
          </a>
        </div>

        {/* 법적 사업자 정보 고지 (전자상거래법 제10조) */}
        <div style={{ marginBottom: "16px" }}>
          <p style={{ fontWeight: 700, color: "#cbd5e1", marginBottom: "4px" }}>
            {PLATFORM.companyName}
          </p>
          <p>
            대표자: {PLATFORM.representative} | 사업자등록번호: {PLATFORM.businessNumber} | 통신판매업신고:{" "}
            {PLATFORM.mailOrderNumber}
          </p>
          <p>
            주소: {PLATFORM.address} | 개인정보보호책임자: {PLATFORM.privacyOfficer} (
            {PLATFORM.privacyEmail})
          </p>
          <p>
            고객지원센터: {PLATFORM.supportPhone} ({PLATFORM.supportHours})
          </p>
        </div>

        {/* 통신판매중개자 면책 + 에스크로/SSL 결제 안전 고지 */}
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
            🛡️ 통신판매중개자 고지 및 구매안전 서비스
          </p>
          <p>
            {PLATFORM.companyName}은(는) 통신판매중개자로서 개별 육류 공급사와 바이어(구매 회원) 간의 주문
            중개 시스템만을 제공하며, 통신판매의 당사자가 아닙니다. 상품의 등록, 재고, 단가, 품질 및 배송에
            대한 일체의 법적 책임은 해당 공급사에 있습니다.
          </p>
          <p style={{ marginTop: "6px" }}>
            <strong style={{ color: "#94a3b8" }}>에스크로(구매안전) 서비스:</strong> 본 플랫폼의 전자결제는
            전자금융거래법에 따라 등록된 PG사를 통해 처리되며, 구매자의 결제 대금은 거래 완료 시점까지
            예치(에스크로)되어 보호됩니다.
          </p>
          <p style={{ marginTop: "6px" }}>
            <strong style={{ color: "#94a3b8" }}>SSL 보안 통신:</strong> 결제 및 개인정보 입력 구간을 포함한
            모든 페이지는 SSL/TLS 암호화(HTTPS) 통신으로 전송되며, 카드 정보는 당사 서버에 저장되지 않고 PG사로
            직접 전달됩니다.
          </p>
        </div>

        <p style={{ fontSize: "11px", color: "#475569", textAlign: "center" }}>
          © 2026 {PLATFORM.companyName}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
