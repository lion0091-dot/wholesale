-- ====================================================================
-- B2B 육류 도매 발주 SaaS - 정식 상용 오픈 전 데이터베이스 클린업 스크립트
-- PRD Section 2.15 & 7.4 준수:
-- 개발 및 사전 테스트 기간 동안 생성된 테스트 발주서, 품목, 데모 상품을
-- 외래키(FK) 무결성 제약조건에 맞춰 안전하게 하드 리셋(Hard Reset)합니다.
-- ====================================================================

BEGIN;

-- 1. 주문 품목 스냅샷 삭제 (FK: order_items -> orders)
DELETE FROM public.order_items;

-- 2. 테스트 발주서 헤더 삭제 (FK: orders -> wholesalers, retailers)
DELETE FROM public.orders;

-- 3. 테스트 맞춤 VIP 단가 삭제 (FK: custom_prices -> products)
DELETE FROM public.custom_prices;

-- 4. 테스트 상품 데이터 삭제 (옵션: 필요 시 특정 데모 도매처 상품만 선별 삭제 가능)
DELETE FROM public.products;

-- 5. 테스트 도매-식당 연결 관계 삭제
DELETE FROM public.wholesaler_retailers;

-- 6. 테스트 식당 바이어 계정 정보 정리 (실제 상용 식당 가입 전 초기화)
DELETE FROM public.retailers;

-- 7. 테스트 도매업자 정보 정리 (슈퍼관리자 계정 제외)
-- 주의: 슈퍼 관리자 프로필은 유지됩니다.
DELETE FROM public.wholesalers
WHERE status = 'rejected' OR business_number = '123-45-67890';

COMMIT;

-- ====================================================================
-- 완료 확인 쿼리 (0건 확인)
-- ====================================================================
-- SELECT COUNT(*) FROM public.orders;
-- SELECT COUNT(*) FROM public.order_items;
-- SELECT COUNT(*) FROM public.products;
