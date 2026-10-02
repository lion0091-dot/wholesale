-- 한 주문에 "박스 없는 재고"(수동 재고·기초잔량 이관분)로 나가는 상품이 둘 이상이면 주문 확정이
-- idx_stock_ledger_idempotent 중복 오류로 실패하던 버그(2026-10-02 실화면 검증에서 발견).
--
-- 원인: 멱등 키가 (event_type, source_type, source_id, inbound_scan_id)인데, 박스 없는 출고 행은
--       inbound_scan_id가 NULL이고 source_id는 상품이 아니라 "주문 ID"라서 상품이 달라도 키가 같아진다.
--       apply_order_shipment(확정)와 reverse_order_shipment(취소 원복) 둘 다 해당.
-- 수정: 키에 product_id를 더한다. 박스가 있는 행은 박스가 곧 상품이라 의미가 안 바뀌고(기존 행은 전부 새 키로도 유일),
--       박스 없는 행만 상품별로 구분된다. 같은 주문·같은 상품·같은 박스의 이중 기록 방지는 그대로다.
--       함수 본문은 건드리지 않는다. 이 인덱스를 대상으로 지정하는 ON CONFLICT는 없다(ensure_opening_balance는 대상 없는 DO NOTHING).
DROP INDEX IF EXISTS public.idx_stock_ledger_idempotent;

CREATE UNIQUE INDEX idx_stock_ledger_idempotent
    ON public.stock_ledger (
        event_type, source_type, source_id, product_id,
        COALESCE(inbound_scan_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE source_id IS NOT NULL;
