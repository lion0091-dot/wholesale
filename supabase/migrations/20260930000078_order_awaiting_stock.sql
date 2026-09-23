-- 재고 없이 받아둔 주문 자리 (확보 대기).
--
-- 고객이 주문 → 공급사가 공급처에 발주 → 공급처가 납품하는 흐름에서는, 주문을
-- 받는 시점에 재고가 없는 게 정상이다. 그런데 apply_order_shipment가 재고 부족이면
-- 확정을 막기 때문에(설계 결정 9번) 주문을 받아둘 자리가 없었다.
--
-- 이 상태는 재고를 건드리지 않는다 — trg_orders_stock_sync는 confirmed/cancelled
-- 로 바뀔 때만 돈다. 물건이 들어와 재고가 생기면 평소대로 confirmed로 넘기고,
-- 그때 정상적으로 차감된다. 새 차감 경로를 만들지 않는 게 핵심이다.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
    CHECK (status = ANY (ARRAY[
        'pending', 'awaiting_stock', 'confirmed', 'shipping', 'delivered',
        'cancel_requested', 'cancel_rejected', 'cancelled'
    ]::text[]));

