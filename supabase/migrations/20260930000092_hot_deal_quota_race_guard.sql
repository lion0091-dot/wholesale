-- 핫딜 한도 동시성 보강 (2026-09-24, 사장님 지적: "경쟁이 발생하면 20을 넘길 수 있다").
--
-- 20260930000091의 hot_deal_quantity_sold 증가는 단순 UPDATE...FROM이라 두 발주가
-- 거의 동시에 확정되면 둘 다 "아직 한도 안 닿음"으로 보고 통과해 한도를 넘길 수 있었다.
-- 재고 부족 체크(apply_order_shipment의 inbound_scans FOR UPDATE)와 같은 방식으로,
-- 상품 행을 FOR UPDATE로 잠그고 확인 → 갱신을 같은 트랜잭션에서 순서대로 처리해
-- 두 번째 확정이 갱신된 값을 다시 보고 정확히 막히도록 한다.
--
-- 재고와 마찬가지로 "한도를 넘기는 확정 자체를 막는다"(RAISE) — 넘긴 채로 확정되고
-- 나중에 발견하는 것보다 낫다는 같은 판단이다(20260930000054 결정 3번과 동일 원칙).

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
    v_hot       RECORD;
    v_product   public.products%ROWTYPE;
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

    -- 핫딜 한도 확인 + 반영을 상품 행 잠금 아래서 순서대로 처리한다(경쟁 시 두 번째
    -- 확정이 갱신된 sold 값을 다시 보고 정확히 막히도록 — 재고 FOR UPDATE와 같은 원리).
    FOR v_hot IN
        SELECT product_id, SUM(quantity) AS quantity
        FROM public.order_items
        WHERE order_id = p_order_id AND is_hot_deal
        GROUP BY product_id
    LOOP
        SELECT * INTO v_product FROM public.products WHERE id = v_hot.product_id FOR UPDATE;

        IF v_product.hot_deal_quantity_limit IS NOT NULL
           AND v_product.hot_deal_quantity_sold + v_hot.quantity > v_product.hot_deal_quantity_limit THEN
            RAISE EXCEPTION 'HOT_DEAL_QUOTA_EXCEEDED:%:%:%:%',
                v_product.name, v_product.hot_deal_quantity_limit, v_product.hot_deal_quantity_sold, v_hot.quantity;
        END IF;

        UPDATE public.products
        SET hot_deal_quantity_sold = hot_deal_quantity_sold + v_hot.quantity
        WHERE id = v_hot.product_id;
    END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_order_shipment(UUID) FROM PUBLIC;
