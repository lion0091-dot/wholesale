-- 거래명세서 PDF(lib/pdf/transaction-statement.tsx)의 "공급자 주소" 칸을 채우기
-- 위한 사업장 소재지 컬럼. wholesalers 테이블엔 지금껏 주소가 없어 PDF에 '-'로
-- 조용히 비어 나가고 있었다.
--
-- 기존 레코드는 전부 NULL로 남는다(백필 데이터 없음) — 공급사가 /dashboard/invites
-- 화면에서 직접 등록해야 한다. lib/orders/statement.ts의 findMissingStatementFields()가
-- NULL을 감지해 PDF 발행 자체를 막고 경고를 보여준다(조용히 '-'로 발행되지 않게).
--
-- NOT NULL 제약을 걸지 않은 이유: 기존 레코드를 이 마이그레이션 하나로 채울 방법이
-- 없고(실제 주소 데이터 없음), 신규 가입(온보딩)도 아직 이 필드를 받지 않는다 —
-- "필수 입력"은 지금 단계에서 애플리케이션 레벨(폼 required + PDF 발행 가드)에서만
-- 강제한다.
ALTER TABLE public.wholesalers
    ADD COLUMN business_address TEXT;

COMMENT ON COLUMN public.wholesalers.business_address IS
    '사업장 소재지. 거래명세서 PDF 공급자란에 사용. 기존 레코드는 NULL — 공급사가 /dashboard/invites에서 직접 등록해야 발행 가능.';
