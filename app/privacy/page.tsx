import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "40px 20px" }}>
      <Link href="/" style={{ fontSize: "13px", color: "#2563eb", textDecoration: "underline" }}>
        ← 메인 홈으로 돌아가기
      </Link>

      <h1 style={{ fontSize: "24px", fontWeight: 800, color: "#0f172a", marginTop: "16px", marginBottom: "8px" }}>
        개인정보처리방침
      </h1>
      <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "32px" }}>
        시행일자: 2026년 9월 9일
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "24px", fontSize: "14px", lineHeight: "1.8", color: "#334155" }}>
        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            1. 수집하는 개인정보 항목 및 수집 방법
          </h2>
          <p>
            회사는 원활한 B2B 발주 중개 및 알림톡 발송을 위해 다음과 같은 최소한의 개인정보를 수집합니다.<br />
            - <strong>도매업자:</strong> 대표자 성명, 휴대전화번호, 사업자등록번호, 사업장 소재지, 상호명<br />
            - <strong>식당 바이어:</strong> 상호명, 담당자 연락처, 배송지 주소, 배송 요청사항 메모
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            2. 개인정보의 이용 목적
          </h2>
          <p>
            - 발주서 생성 및 도매업자 앞으로의 발주 내역 카카오 알림톡(AlimTalk) 전송<br />
            - 주문 상품의 정확한 배송지 확인 및 배송 상태 업데이트<br />
            - 부정 이용 방지 및 분쟁 조정을 위한 기록 보존
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            3. 개인정보의 보유 및 파기
          </h2>
          <p>
            전자상거래 등에서의 소비자보호에 관한 법률 등 관계 법령의 규정에 의하여 계약 또는 청약철회 등에 관한 기록, 대금결제 및 재화 등의 공급에 관한 기록은 5년간 보관 후 지체 없이 영구 파기합니다.
          </p>
        </section>
      </div>
    </main>
  );
}
