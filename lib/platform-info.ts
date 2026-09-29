/**
 * 전자상거래법·정보통신망법상 의무 표시 사항(사업자 정보). 실제 값은 환경변수로 주입하고,
 * 미설정 시 기본값을 쓴다. "use client" 파일에 두면 서버 컴포넌트(약관·개인정보처리방침)에서
 * 값이 비어 나오므로 서버·클라이언트 양쪽에서 쓸 수 있게 별도 모듈로 둔다.
 */
export const PLATFORM = {
  companyName: process.env.NEXT_PUBLIC_COMPANY_NAME || "미트 파트너스",
  // 통신판매업 신고증상 법적 상호. companyName은 서비스 브랜드명으로 병기한다.
  legalName: process.env.NEXT_PUBLIC_COMPANY_LEGAL_NAME || "장터",
  representative: process.env.NEXT_PUBLIC_COMPANY_REPRESENTATIVE || "권영성",
  businessNumber: process.env.NEXT_PUBLIC_COMPANY_BUSINESS_NUMBER || "455-17-02259",
  mailOrderNumber:
    process.env.NEXT_PUBLIC_COMPANY_MAIL_ORDER_NUMBER || "제 2024-경기안산-5773호",
  address:
    process.env.NEXT_PUBLIC_COMPANY_ADDRESS ||
    "경기도 안산시 단원구 광덕4로 116, 대덕프라자 5층 502호(고잔동)",
  privacyOfficer: process.env.NEXT_PUBLIC_PRIVACY_OFFICER || "권영성",
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@wholesale-meat.kr",
  privacyEmail: process.env.NEXT_PUBLIC_PRIVACY_EMAIL || "privacy@wholesale-meat.kr",
  supportPhone: process.env.NEXT_PUBLIC_SUPPORT_PHONE || "1588-0000",
  supportHours: process.env.NEXT_PUBLIC_SUPPORT_HOURS || "평일 09:00 ~ 18:00 (토/일/공휴일 휴무)",
};
