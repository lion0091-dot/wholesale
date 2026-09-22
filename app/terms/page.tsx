import Link from "next/link";
import { PLATFORM } from "@/components/legal-footer";

/**
 * 서비스 이용약관.
 *
 * ⚠️ 초안입니다. 정식 게시 전 변호사 검토를 받아야 합니다. 특히 결제/환불/해지
 * 조항(5~7조)은 실제 운영 방식(계좌이체 수기 확인)에 맞춰 검증이 필요합니다.
 * 사업자 정보는 legal-footer.tsx와 같은 환경변수(NEXT_PUBLIC_COMPANY_*)를 쓴다 —
 * 이 페이지만 따로 하드코딩돼 있던 걸 통일함.
 */
export default function TermsPage() {
  return (
    <main style={{ maxWidth: "768px", margin: "0 auto", padding: "40px 20px" }}>
      <Link href="/" style={{ fontSize: "13px", color: "#2563eb", textDecoration: "underline" }}>
        ← 메인 홈으로 돌아가기
      </Link>

      <h1 style={{ fontSize: "24px", fontWeight: 800, color: "#0f172a", marginTop: "16px", marginBottom: "8px" }}>
        서비스 이용약관
      </h1>
      <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "16px" }}>
        시행일자: 2026년 9월 9일
      </p>

      <div
        style={{
          backgroundColor: "#fef3c7",
          border: "1px solid #fde68a",
          color: "#92400e",
          fontSize: "12px",
          padding: "12px 16px",
          borderRadius: "8px",
          lineHeight: 1.7,
          marginBottom: "32px",
        }}
      >
        ⚠️ 이 문서는 초안입니다. <strong>[대괄호]</strong>로 표시된 항목은 실제 사업자 정보/기한으로
        채워야 하고, 정식 게시 전 변호사 검토가 필요합니다.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "24px", fontSize: "14px", lineHeight: "1.8", color: "#334155" }}>
        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제1조 (목적)
          </h2>
          <p>
            본 약관은 미트 파트너스(이하 &apos;회사&apos;)이 제공하는 비공개 폐쇄형 B2B 육류 모바일 발주 중개 솔루션(이하 &apos;서비스&apos;)의 이용과 관련하여 회사와 이용자(공급사(도매) 및 고객(소매)) 간의 권리, 의무 및 책임사항을 규정함을 목적으로 합니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제2조 (용어의 정의)
          </h2>
          <p>
            1. &apos;공급사(도매)&apos;란 본 플랫폼의 승인을 득하고 월 구독료를 납부하여 고객(소매)에게 전용 모바일 미니샵을 제공하고 상품을 등록/판매하는 사업자를 말합니다.<br />
            2. &apos;고객(소매)&apos;란 특정 공급사(도매)로부터 고유 접속 토큰 URL을 제공받아 모바일로 육류 발주서를 작성/제출하는 정육점, 식당, 유통 등 구매 사업자를 말합니다.<br />
            3. &apos;핫딜&apos;이란 공급사(도매)가 재고처분 등의 목적으로 지정한 고객(소매)에게만 한정 수량 특가 육류를 판매하는 별도 단가 체계를 의미합니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제3조 (통신판매중개자로서의 지위와 면책)
          </h2>
          <p>
            1. 회사는 공급사(도매)와 고객(소매) 간의 1:1 직거래 발주 편의를 지원하는 통신판매중개자이며, 거래되는 육류의 당사자가 아닙니다.<br />
            2. 육류의 원산지, 등급, 품질, 실중량 차이, 유통기한, 배송 및 대금 정산에 관한 책임은 거래 당사자인 공급사(도매)와 고객(소매)에게 있습니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제4조 (계정 분리 및 경쟁 침해 방지)
          </h2>
          <p>
            플랫폼의 보안성과 상호 가격 비밀 유지를 위해 단일 계정은 공급사(도매) 권한과 고객(소매) 권한을 동시에 가질 수 없으며, 타 공급사(도매)의 단가 정보를 부정하게 취득하기 위해 허위 가입한 사실이 적발될 경우 즉시 이용이 영구 정지될 수 있습니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제5조 (구독료 및 결제)
          </h2>
          <p>
            1. 공급사(도매)는 서비스 이용을 위해 회사가 정한 월 구독료를 납부하여야 하며, 구체적인 금액과 플랜은 [요금 안내 페이지 또는 별도 계약서]에 따릅니다.<br />
            2. 결제는 현재 계좌이체 방식으로 진행되며, 회사가 입금을 확인한 후 서비스 이용 상태(구독 상태)에 반영합니다. 회사는 추후 결제대행(PG)사를 통한 자동 결제로 결제 방식을 변경할 수 있으며, 이 경우 사전에 공지합니다.<br />
            3. 구독료는 월 단위로 청구되며, 이용 개시일이 월 중간인 경우에도 별도의 일할 계산 없이 해당 월은 무료 체험 또는 회사가 정하는 기준으로 처리하고 익월부터 정상 청구함을 원칙으로 합니다. 회사는 개별 사안에 따라 예외를 정할 수 있습니다.<br />
            4. 구독료가 납부기한 내 확인되지 않는 경우 회사는 [ ]일간의 유예기간을 부여한 후에도 미납이 지속되면 사전 통지하고 서비스 이용을 일시정지할 수 있습니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제6조 (환불 및 해지)
          </h2>
          <p>
            1. 공급사(도매)는 언제든지 서비스 이용 해지를 요청할 수 있으며, 해지 신청일이 속한 달의 구독료는 환불되지 않고 다음 달부터 청구가 중단됩니다.<br />
            2. 회사의 귀책사유로 서비스를 상당 기간(합산 [ ]일 이상) 정상적으로 제공하지 못한 경우, 회사는 그 기간에 상응하는 구독료를 환불하거나 이용 기간을 연장할 수 있습니다.<br />
            3. 그 밖의 환불에 관한 사항은 관계 법령 및 회사가 정하는 별도 기준에 따릅니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제7조 (이용계약의 해지 및 회원 탈퇴)
          </h2>
          <p>
            1. 회원은 언제든지 [고객센터 이메일/연락처]로 요청하여 회원 탈퇴 및 이용계약 해지를 할 수 있습니다.<br />
            2. 회사는 회원이 제4조를 위반하거나 관계 법령 또는 본 약관을 위반한 경우, 사전 통지 후 이용계약을 해지하거나 서비스 이용을 제한할 수 있습니다. 다만 긴급히 조치가 필요한 경우 사후에 통지할 수 있습니다.<br />
            3. 탈퇴 시 회사가 보유한 회원의 개인정보는 제8조 및 관계 법령이 정한 보유기간에 따라 처리됩니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제8조 (개인정보의 보호)
          </h2>
          <p>
            회사는 관계 법령이 정하는 바에 따라 회원의 개인정보를 보호하기 위해 노력하며, 개인정보의 수집·이용·보관·파기 등 구체적인 사항은 별도로 게시하는{" "}
            <Link href="/privacy" style={{ color: "#2563eb", textDecoration: "underline" }}>
              개인정보처리방침
            </Link>
            에 따릅니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제9조 (약관의 개정)
          </h2>
          <p>
            1. 회사는 관계 법령을 위반하지 않는 범위에서 본 약관을 개정할 수 있습니다.<br />
            2. 약관을 개정하는 경우 회사는 적용일자와 개정 사유를 명시하여 적용일 [7]일 전부터 서비스 초기화면 또는 공지사항을 통해 공지합니다. 다만 회원에게 불리한 변경의 경우 적용일 [30]일 전부터 공지합니다.<br />
            3. 회원이 개정 약관 공지 후에도 이의를 제기하지 않고 서비스를 계속 이용하는 경우, 개정 약관에 동의한 것으로 봅니다.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>
            제10조 (분쟁해결 및 준거법)
          </h2>
          <p>
            1. 본 약관은 대한민국 법령에 따라 규율되고 해석됩니다.<br />
            2. 서비스 이용과 관련하여 회사와 회원 간 분쟁이 발생한 경우 상호 협의하여 해결함을 원칙으로 하며, 협의가 이루어지지 않을 경우 민사소송법상의 관할법원에 소를 제기할 수 있습니다.
          </p>
        </section>
      </div>

      <footer
        style={{
          marginTop: "40px",
          paddingTop: "20px",
          borderTop: "1px solid #e2e8f0",
          fontSize: "12px",
          color: "#64748b",
          lineHeight: 1.8,
        }}
      >
        <div style={{ fontWeight: 700, color: "#334155", marginBottom: "6px" }}>사업자 정보</div>
        상호: {PLATFORM.companyName} | 대표자: {PLATFORM.representative}
        <br />
        사업자등록번호: {PLATFORM.businessNumber} | 통신판매업 신고번호: {PLATFORM.mailOrderNumber}
        <br />
        사업장 소재지: {PLATFORM.address}
        <br />
        고객센터: {PLATFORM.supportEmail} / {PLATFORM.supportPhone}
      </footer>
    </main>
  );
}
