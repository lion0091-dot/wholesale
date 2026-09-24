-- PG 결제 1건 = 주문 1건 — 멱등키 (2026-09-24 점검 3: PG 유령주문·중복 처리)
--
-- 주문을 만드는 경로가 둘이다: 승인 콜백(checkout/pg/success/route.ts)과 재대조
-- (lib/payments/pg-reconcile.ts — 주문내역 재방문·매일 크론). 둘 다 "대기 행이
-- 있으면 주문 생성 → 대기 행 삭제" 순서인데 orders.pg_order_id에 유니크가 없어서,
-- 콜백이 주문을 만든 직후 대기 행 삭제만 실패하면(네트워크 순단) 다음 날 크론이
-- 토스 "결제완료"를 보고 같은 결제로 두 번째 주문을 만들 수 있었다. 크론과 재방문이
-- 같은 대기 행을 동시에 집어도 마찬가지.
--
-- 토스가 발급하는 결제키가 아니라 우리가 발급한 pg_order_id(결제창 열기 전 생성,
-- pg_pending_payments.pg_order_id UNIQUE)를 멱등키로 쓴다 — 재대조 시점엔 결제키를
-- 모를 수 있지만 pg_order_id는 항상 안다. 서버 코드(finalizePaidOrder)는 생성 전에
-- 같은 pg_order_id 주문이 있는지 먼저 보고, 있으면 만들지 않고 대기 행만 정리한다.
-- 이 인덱스는 그 검사 사이를 뚫고 들어오는 동시 실행까지 막는 최후 방어선이다.
--
-- 라이브에는 PG 주문이 0건(토스 계정 미발급)이라 기존 데이터 충돌은 없다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pg_order_id_unique
    ON public.orders (pg_order_id)
    WHERE pg_order_id IS NOT NULL;

COMMENT ON INDEX public.idx_orders_pg_order_id_unique IS
    'PG 결제 1건당 주문 1건. 승인 콜백과 재대조가 겹쳐도 두 번째 생성을 DB가 거부한다.';
