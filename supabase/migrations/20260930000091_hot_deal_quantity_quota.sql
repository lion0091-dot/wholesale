-- 핫딜 "판매 수량 한도" 추가 (2026-09-24, 사장님 확정).
--
-- 배경: 총재고 50개 중 20개만 핫딜가로 팔고 싶다는 요구 → 지금 구조(상품 전체가
-- 핫딜/일반 둘 중 하나)로는 표현이 안 됨을 확인 → 논의 끝에 "판매 수량 한도" 모델로
-- 확정. 상품은 하나(재고도 공유)로 유지하되, 핫딜가로 누적 판매된 수량이 한도에
-- 닿으면 그 시점부터 일반 매장에서 기본 단가로 자동 판매된다.
--
-- 잠긴 설계 결정:
--   1. hot_deal_quantity_limit이 NULL이면 무제한 — 기존 동작(재고 전부 핫딜가)과
--      동일하다. 값을 넣으면 그 수량까지만 핫딜가로 판매된다.
--   2. hot_deal_quantity_sold는 주문 "확정" 시점에 늘고 "취소" 시점에 줄어든다
--      (재고 차감/원복과 똑같은 트리거 지점 — apply_order_shipment/
--      reverse_order_shipment). 확정 전(pending)엔 아직 핫딜 소비로 잡지 않는다.
--   3. 한도 도달은 hot_deal_active를 끄지 않는다. 상품은 여전히 "핫딜 상품"으로
--      남고(관리자가 상품 화면에서 직접 꺼야 완전히 종료), 다만 그 순간부터
--      카탈로그 가격 계산에서 핫딜가 적용을 멈추고 일반가로 되돌아간다 —
--      곧 일반 매장에서 자동으로 다시 구매 가능해진다는 뜻이다.
--   4. 재고 0에 의한 자동 발주정지(order_stopped, 20260930000090)와는 별개다.
--      한도 소진은 "핫딜가 적용만" 멈추고 상품 자체는 계속 팔린다(일반가로).
--      order_stopped는 재고 자체가 없거나 관리자가 전체 판매를 막은 경우다.

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS hot_deal_quantity_limit NUMERIC(10, 2)
        CHECK (hot_deal_quantity_limit IS NULL OR hot_deal_quantity_limit > 0),
    ADD COLUMN IF NOT EXISTS hot_deal_quantity_sold  NUMERIC(10, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.products.hot_deal_quantity_limit IS
    '핫딜가로 팔 수 있는 최대 수량. NULL이면 무제한(재고 전체가 핫딜가).';
COMMENT ON COLUMN public.products.hot_deal_quantity_sold IS
    '핫딜가로 누적 판매된 수량(확정 시 증가, 취소 시 감소). 한도에 닿으면 카탈로그가 자동으로 기본가로 되돌아간다.';

-- 주문 품목이 "핫딜가로 팔린 줄"인지 스냅샷 — 상품의 hot_deal_active가 나중에
-- 바뀌어도(꺼지거나 한도가 바뀌어도) 이 주문이 핫딜 소비였는지 판별할 수 있어야
-- hot_deal_quantity_sold를 정확히 원복할 수 있다.
ALTER TABLE public.order_items
    ADD COLUMN IF NOT EXISTS is_hot_deal BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.order_items.is_hot_deal IS
    '주문 시점에 핫딜가로 팔렸는지 스냅샷. products.hot_deal_quantity_sold 증감 판정에 쓰인다.';


-- --------------------------------------------------------------------
-- apply_order_shipment / reverse_order_shipment 확장 — 재고 차감/원복과 같은
-- 트랜잭션에서 핫딜 판매 수량도 같이 늘리고/줄인다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_order_shipment(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order     public.orders%ROWTYPE;
    v_item      RECORD;
    v_box       RECORD;
    v_remaining NUMERIC(10, 2);
    v_take      NUMERIC(10, 2);
    v_available NUMERIC(10, 2);
BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
    IF v_order.id IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_OUT'
    ) THEN
        RETURN;
    END IF;

    FOR v_item IN
        SELECT product_id, SUM(quantity) AS quantity, MAX(product_name) AS product_name
        FROM public.order_items
        WHERE order_id = p_order_id
        GROUP BY product_id
    LOOP
        PERFORM public.ensure_opening_balance(v_item.product_id);

        SELECT COALESCE(SUM(qty_delta), 0) INTO v_available
        FROM public.stock_ledger WHERE product_id = v_item.product_id;

        IF v_available < v_item.quantity THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
                v_item.product_name, v_available, v_item.quantity;
        END IF;

        v_remaining := v_item.quantity;

        FOR v_box IN
            SELECT id, remaining_weight
            FROM public.inbound_scans
            WHERE wholesaler_id = v_order.wholesaler_id
              AND product_id = v_item.product_id
              AND status = 'NORMAL'
              AND remaining_weight > 0
            ORDER BY created_at
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            v_take := LEAST(v_box.remaining_weight, v_remaining);

            UPDATE public.inbound_scans
            SET remaining_weight = remaining_weight - v_take
            WHERE id = v_box.id;

            INSERT INTO public.stock_ledger (
                wholesaler_id, product_id, inbound_scan_id, qty_delta,
                event_type, source_type, source_id, created_by
            ) VALUES (
                v_order.wholesaler_id, v_item.product_id, v_box.id, -v_take,
                'ORDER_OUT', 'order', p_order_id, auth.uid()
            );

            v_remaining := v_remaining - v_take;
        END LOOP;

        IF v_remaining > 0 THEN
            INSERT INTO public.stock_ledger (
                wholesaler_id, product_id, inbound_scan_id, qty_delta,
                event_type, source_type, source_id, reason, created_by
            ) VALUES (
                v_order.wholesaler_id, v_item.product_id, NULL, -v_remaining,
                'ORDER_OUT', 'order', p_order_id, '이력 미추적 재고분', auth.uid()
            );
        END IF;

        PERFORM public.recalc_product_stock(v_item.product_id);
    END LOOP;

    -- 핫딜가로 팔린 품목만 따로 모아 hot_deal_quantity_sold에 반영한다.
    UPDATE public.products p
    SET hot_deal_quantity_sold = hot_deal_quantity_sold + hot.quantity
    FROM (
        SELECT product_id, SUM(quantity) AS quantity
        FROM public.order_items
        WHERE order_id = p_order_id AND is_hot_deal
        GROUP BY product_id
    ) hot
    WHERE p.id = hot.product_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_order_shipment(UUID) FROM PUBLIC;


CREATE OR REPLACE FUNCTION public.reverse_order_shipment(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row RECORD;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_OUT'
    ) THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_RESTORE'
    ) THEN
        RETURN;
    END IF;

    FOR v_row IN
        SELECT wholesaler_id, product_id, inbound_scan_id, SUM(qty_delta) AS qty_delta
        FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id
          AND event_type IN ('ORDER_OUT', 'OUTBOUND_UNASSIGN', 'OUTBOUND_ASSIGN')
        GROUP BY wholesaler_id, product_id, inbound_scan_id
        HAVING SUM(qty_delta) <> 0
    LOOP
        IF v_row.inbound_scan_id IS NOT NULL THEN
            UPDATE public.inbound_scans
            SET remaining_weight = remaining_weight + (-v_row.qty_delta)
            WHERE id = v_row.inbound_scan_id AND status = 'NORMAL';
        END IF;

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) VALUES (
            v_row.wholesaler_id, v_row.product_id, v_row.inbound_scan_id, -v_row.qty_delta,
            'ORDER_RESTORE', 'order', p_order_id, '주문 취소 원복', auth.uid()
        );

        PERFORM public.recalc_product_stock(v_row.product_id);
    END LOOP;

    -- 핫딜 판매 수량도 되돌린다(한도 아래로 다시 내려가면 카탈로그가 자동으로 핫딜가를 재적용).
    UPDATE public.products p
    SET hot_deal_quantity_sold = GREATEST(0, hot_deal_quantity_sold - hot.quantity)
    FROM (
        SELECT product_id, SUM(quantity) AS quantity
        FROM public.order_items
        WHERE order_id = p_order_id AND is_hot_deal
        GROUP BY product_id
    ) hot
    WHERE p.id = hot.product_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reverse_order_shipment(UUID) FROM PUBLIC;
