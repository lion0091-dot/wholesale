-- 장바구니 네고(32단계) — PG 결제 경로 보강
--
-- PG 결제는 "결제 확정 후에만 주문 생성" 원칙이라(pg_pending_payments) 결제 승인
-- 전에는 orders 행이 없다. negotiation_note는 orders 컬럼이라 결제 승인 콜백
-- (checkout/pg/success/route.ts)이 실제 orders 행을 만들 때 이 값을 가져다 써야
-- 하므로, cart_snapshot과 마찬가지로 대기 테이블에 잠시 실어 보낸다.

ALTER TABLE public.pg_pending_payments
    ADD COLUMN IF NOT EXISTS negotiation_note TEXT;

COMMENT ON COLUMN public.pg_pending_payments.negotiation_note IS
    '결제 승인 성공 시 orders.negotiation_note로 그대로 옮겨진다.';
