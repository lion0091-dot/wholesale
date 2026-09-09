import Link from "next/link";

export default function TermsPage() {
  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "40px 20px" }}>
      <Link href="/" style={{ fontSize: "13px", color: "#2563eb", textDecoration: "underline" }}>
        ← 메인 홈으로 돌아가기
      </Link>

      <h1 style={{ fontSize: "24px", fontWeight: 800, color: "#0f172a", marginTop: "16px", marginBottom: "8px" }}>
        서비스 이용약관
      </h1>
      <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "32px" }}>
        시행일자: 2026년 9월 9일
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "24px", fontSize: "14px", lineHeight: "1.8", color: "#334155" }}>
        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제1조 (목적)
          </h2>
          <p>
            본 약관은 (주)미트체인(이하 &apos;회사&apos;)이 제공하는 비공개 폐쇄형 B2B 육류 모바일 발주 중개 솔루션(이하 &apos;서비스&apos;)의 이용과 관련하여 회사와 이용자(도매업자 및 바이어(구매 회원)) 간의 권리, 의무 및 책임사항을 규정함을 목적으로 합니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제2조 (용어의 정의)
          </h2>
          <p>
            1. &apos;도매업자(판매자)&apos;란 본 플랫폼의 승인을 득하고 월 구독료를 납부하여 바이어(구매 회원)에게 전용 모바일 미니샵을 제공하고 상품을 등록/판매하는 사업자를 말합니다.<br />
            2. &apos;바이어(구매 회원)&apos;란 특정 도매업자로부터 고유 접속 토큰 URL을 제공받아 모바일로 육류 발주서를 작성/제출하는 정육점, 식당, 유통 등 구매 사업자를 말합니다.<br />
            3. &apos;시크릿 딜 룸&apos;이란 도매업자가 일반 시장 가격 붕괴를 방지하기 위해 인증된 구매 회원(바이어)에게만 한정 수량 특가 육류를 판매하는 비공개 거래 공간을 의미합니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제3조 (통신판매중개자로서의 지위와 면책)
          </h2>
          <p>
            1. 회사는 도매업자와 바이어(구매 회원) 간의 1:1 직거래 발주 편의를 지원하는 통신판매중개자이며, 거래되는 육류의 당사자가 아닙니다.<br />
            2. 육류의 원산지, 등급, 품질, 실중량 차이, 유통기한, 배송 및 대금 정산에 관한 책임은 거래 당사자인 도매업자와 바이어(구매 회원)에게 있습니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제4조 (계정 분리 및 경쟁 침해 방지)
          </h2>
          <p>
            플랫폼의 보안성과 상호 가격 비밀 유지를 위해 단일 계정은 도매업자 권한과 바이어(구매 회원) 권한을 동시에 가질 수 없으며, 타 도매업자의 단가 정보를 부정하게 취득하기 위해 허위 가입한 사실이 적발될 경우 즉시 이용이 영구 정지될 수 있습니다.
          </p>
        </section>
      </div>
    </main>
  );
}
