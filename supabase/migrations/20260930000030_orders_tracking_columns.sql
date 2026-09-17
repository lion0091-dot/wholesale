-- ====================================================================
-- 배송 조회(스위트트래커 연동): 주문에 택배사/운송장번호 컬럼 추가
-- 조회는 매번 라이브 API 호출이라 상태 캐싱 컬럼은 두지 않는다.
-- RLS/트리거 변경 불필요 — 기존 UPDATE 정책이 소유 공급사/조직 직원에게
-- 이미 무제한 쓰기를 허용하고, status를 안 건드리는 업데이트는
-- enforce_order_cancel_authority 트리거도 그냥 통과한다.
-- ====================================================================

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS courier_code TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
