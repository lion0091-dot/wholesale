-- 핫딜 한도 소비 시점을 "확정"에서 "결제(발주 생성)"로 이동 (2026-09-24, 사장님 확정).
--
-- 배경: 20260930000091/092는 한도 소비/검증을 공급사가 "확정" 버튼을 누르는 시점에
-- 했다. 그런데 핫딜은 손님들이 실시간으로 경쟁 구매하는 상황이라, 확정은 공급사가
-- 나중에(몇 시간~며칠 뒤) 처리할 수도 있는 별개 행위다 — 그때 가서야 한도 초과를
-- 발견해 거부하면, 손님은 이미 "발주 완료"를 봤는데 나중에 뒤집히는 나쁜 경험이 된다.
--
-- 잠긴 설계 결정 (이번 수정):
--   1. 핫딜 한도는 발주 "생성"(결제 완료) 순간에 소비된다. 재고 차감(확정 시점)과는
--      이제 다른 시점이다 — 한도는 "동시 경쟁 구매"를 막는 게 목적이라 손님이 실제로
--      버튼을 누르는 순간 자리를 잡아야 의미가 있다.
--   2. 상품 행을 FOR UPDATE로 잠그고 확인 → 증가를 한 트랜잭션에서 처리해 여러 발주가
--      동시에 들어와도 순서대로 처리된다. 한도를 넘기는 발주는 생성 자체가 거부된다
--      (신용한도 초과 시 발주를 되돌리는 apply_credit_order와 동일한 보상 삭제 패턴 —
--      app/shop/[shop_token]/actions.ts가 RPC 실패 시 주문 행을 지운다).
--   3. 확정 시점(apply_order_shipment/reverse_order_shipment)은 이제 핫딜 한도를
--      건드리지 않는다 — 재고 차감/원복만 담당하던 원래 역할로 되돌린다(20260930000054).
--   4. 취소는 확정 여부와 무관하게(pending에서 취소돼도) 한도를 반환해야 한다 —
--      결제 시점에 이미 소비했기 때문이다. release_hot_deal_quota를 새로 만들어
--      sync_order_stock()의 취소 분기에서 reverse_order_shipment와 함께 호출한다.

-- --------------------------------------------------------------------
-- 1. apply_order_shipment / reverse_order_shipment를 재고 전담으로 되돌린다
--    (핫딜 한도 UPDATE 블록 제거, 나머지는 20260930000054와 동일).
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
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reverse_order_shipment(UUID) FROM PUBLIC;


-- --------------------------------------------------------------------
-- 2. 핫딜 한도 예약(결제 시점) / 반환(취소 시점).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_hot_deal_quota(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hot     RECORD;
    v_product public.products%ROWTYPE;
BEGIN
    FOR v_hot IN
        SELECT product_id, SUM(quantity) AS quantity
        FROM public.order_items
        WHERE order_id = p_order_id AND is_hot_deal
        GROUP BY product_id
        -- product_id 오름차순으로 고정해 동시 결제 간 잠금 순서를 일치시킨다
        -- (apply_order_shipment의 inbound_scans ORDER BY created_at과 같은 이유의
        -- 데드락 방지 — GROUP BY만으로는 해시 순서가 백엔드마다 달라질 수 있다).
        ORDER BY product_id
    LOOP
        -- 상품 행을 잠가 동시 결제가 순서대로 처리되게 한다(재고 FOR UPDATE와 같은 원리).
        SELECT * INTO v_product FROM public.products WHERE id = v_hot.product_id FOR UPDATE;

        IF v_product.id IS NULL THEN
            RAISE EXCEPTION 'HOT_DEAL_PRODUCT_NOT_FOUND';
        END IF;

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

REVOKE EXECUTE ON FUNCTION public.reserve_hot_deal_quota(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_hot_deal_quota(UUID) TO authenticated;

COMMENT ON FUNCTION public.reserve_hot_deal_quota(UUID) IS
    '발주 생성 직후 호출된다. 한도를 넘기면 예외를 던지고(전체 롤백), 호출자가 주문을 삭제하고 손님에게 재시도를 안내한다.';


CREATE OR REPLACE FUNCTION public.release_hot_deal_quota(p_order_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.products p
    SET hot_deal_quantity_sold = GREATEST(0, hot_deal_quantity_sold - hot.quantity)
    FROM (
        SELECT product_id, SUM(quantity) AS quantity
        FROM public.order_items
        WHERE order_id = p_order_id AND is_hot_deal
        GROUP BY product_id
    ) hot
    WHERE p.id = hot.product_id;
$$;

REVOKE EXECUTE ON FUNCTION public.release_hot_deal_quota(UUID) FROM PUBLIC;

COMMENT ON FUNCTION public.release_hot_deal_quota(UUID) IS
    '주문 취소 시 결제 때 예약했던 핫딜 한도를 되돌린다. 확정 여부와 무관하게(pending에서 취소돼도) 호출해야 한다 — 한도는 결제 시점에 이미 소비됐기 때문.';


-- --------------------------------------------------------------------
-- 3. 취소 트리거에 핫딜 한도 반환을 추가한다. 재고 원복(reverse_order_shipment)은
--    확정된 적 있는 주문만 대상이지만, 핫딜 한도는 결제 시점에 소비되므로 확정
--    여부와 무관하게 항상 반환해야 한다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_order_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
        PERFORM public.apply_order_shipment(NEW.id);

    ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
        PERFORM public.reverse_order_shipment(NEW.id);
        PERFORM public.release_hot_deal_quota(NEW.id);
    END IF;

    RETURN NEW;
END;
$$;
