-- ====================================================================
-- 중량 정밀도를 g 단위로 — NUMERIC(10,2) → NUMERIC(10,3)
--
-- 바코드는 g 단위로 온다. GS1-128 계량 AI `3103`은 소수점 3자리라
-- "008204" 는 8.204kg 이다. 파서는 그걸 제대로 읽어내는데 저장할 때
-- 소수점 둘째 자리에서 반올림돼 8.20kg 이 됐다 — 박스당 최대 5g 이
-- 조용히 사라지거나 생겼다.
--
-- 한우 1++ 기준 하루 100박스면 하루 수만 원이 장부에서 어긋난다.
-- 방향이 랜덤이라 서로 상쇄되기도 하는데, 그래서 더 아무도 못 잡는다.
--
-- 잠긴 설계 결정:
--
--  1. kg 단위를 유지하고 소수 자릿수만 늘린다. g 정수로 바꾸면 기존
--     데이터·화면·API 전부가 1000배 단위 변환을 타야 하고, 한 군데라도
--     빠뜨리면 재고가 1000배로 틀어진다.
--
--  2. 금액 컬럼(unit_price, subtotal_amount, total_amount)은 건드리지
--     않는다. 원 단위 이하는 쓰지 않는다.
--
--  3. RPC 안의 지역변수도 같이 올린다. 컬럼만 올리면 계산 도중에
--     NUMERIC(10,2) 변수를 거치면서 도로 반올림된다 — 컬럼이 3자리를
--     받아도 들어가는 값이 이미 깎여 있다.
-- ====================================================================

-- (1) 컬럼 정밀도
ALTER TABLE public.products
    ALTER COLUMN stock_quantity TYPE NUMERIC(10, 3);

ALTER TABLE public.order_items
    ALTER COLUMN quantity TYPE NUMERIC(10, 3);

ALTER TABLE public.inbound_scans
    ALTER COLUMN weight TYPE NUMERIC(10, 3),
    ALTER COLUMN remaining_weight TYPE NUMERIC(10, 3);

ALTER TABLE public.stock_ledger
    ALTER COLUMN qty_delta TYPE NUMERIC(10, 3);

ALTER TABLE public.inbound_import_rows
    ALTER COLUMN weight TYPE NUMERIC(10, 3);

-- (2) 계산 도중 반올림을 막기 위해 지역변수도 함께 올린다 (설계 결정 3번).

-- apply_order_shipment: 지역변수 3개
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
    v_remaining NUMERIC(10, 3);
    v_take      NUMERIC(10, 3);
    v_available NUMERIC(10, 3);
BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
    IF v_order.id IS NULL THEN
        RETURN;
    END IF;

    -- 이미 차감된 주문이면 아무것도 하지 않는다 (설계 결정 5번).
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
        -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 기초재고로 옮긴다.
        PERFORM public.ensure_opening_balance(v_item.product_id);

        SELECT COALESCE(SUM(qty_delta), 0) INTO v_available
        FROM public.stock_ledger WHERE product_id = v_item.product_id;

        IF v_available < v_item.quantity THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
                v_item.product_name, v_available, v_item.quantity;
        END IF;

        v_remaining := v_item.quantity;

        -- (a) 이력 추적되는 박스에서 선입선출로 뺀다.
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

        -- (b) 박스로 못 채운 분량(기초재고/스캔 미사용 상품)은 박스 없이 뺀다.
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

-- adjust_product_stock: 지역변수 2개
CREATE OR REPLACE FUNCTION public.adjust_product_stock(
    p_product_id   UUID,
    p_new_quantity NUMERIC,
    p_reason_code  TEXT,
    p_reason_note  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_product       public.products%ROWTYPE;
    v_current       NUMERIC(10, 3);
    v_delta         NUMERIC(10, 3);
    v_event_type    TEXT;
    v_reason_label  TEXT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    SELECT * INTO v_product FROM public.products WHERE id = p_product_id;

    IF v_product.id IS NULL THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    IF v_product.wholesaler_id <> v_wholesaler_id
       AND public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    -- resolve_current_wholesaler_id()는 owner/manager/staff 구분 없이 통과시키므로,
    -- 화면(상품관리)과 같은 owner/manager 전용 게이트를 여기서도 건다.
    IF v_wholesaler_id <> public.get_current_wholesaler_id()
       AND NOT public.is_org_staff_of_wholesaler(v_wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[])
       AND public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    v_reason_label := CASE p_reason_code
        WHEN 'STOCKTAKE' THEN '재고 실사'
        WHEN 'DISPOSAL'  THEN '폐기'
        WHEN 'DAMAGE'    THEN '파손·손실'
        WHEN 'RETURN'    THEN '반품 입고'
        WHEN 'OTHER'     THEN '기타'
        ELSE NULL
    END;

    IF v_reason_label IS NULL THEN
        RAISE EXCEPTION 'INVALID_REASON';
    END IF;

    -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 기초재고로 먼저 옮긴다.
    PERFORM public.ensure_opening_balance(p_product_id);

    SELECT COALESCE(SUM(qty_delta), 0) INTO v_current
    FROM public.stock_ledger WHERE product_id = p_product_id;

    v_delta := p_new_quantity - v_current;

    IF v_delta = 0 THEN
        RETURN jsonb_build_object('changed', false, 'stock_quantity', v_current);
    END IF;

    -- 폐기/파손으로 줄어든 건 손실(LOSS)로 구분해 남긴다 — 나중에 손실률 집계에 쓴다.
    v_event_type := CASE
        WHEN v_delta < 0 AND p_reason_code IN ('DISPOSAL', 'DAMAGE') THEN 'LOSS'
        ELSE 'ADJUSTMENT'
    END;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) VALUES (
        v_product.wholesaler_id, p_product_id, NULL, v_delta,
        v_event_type, 'manual', NULL,
        v_reason_label || COALESCE(' — ' || NULLIF(btrim(p_reason_note), ''), ''),
        auth.uid()
    );

    PERFORM public.recalc_product_stock(p_product_id);

    RETURN jsonb_build_object(
        'changed', true,
        'delta', v_delta,
        'stock_quantity', p_new_quantity,
        'event_type', v_event_type
    );
END;
$$;

-- record_outbound_scan: 지역변수 4개
CREATE OR REPLACE FUNCTION public.record_outbound_scan(
    p_order_id UUID,
    p_trace_no TEXT,
    p_weight   NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_order         public.orders%ROWTYPE;
    v_trace_no      TEXT;
    v_box           public.inbound_scans%ROWTYPE;
    v_ordered       NUMERIC(10, 3);
    v_assigned      NUMERIC(10, 3);
    v_needed        NUMERIC(10, 3);
    v_take          NUMERIC(10, 3);
    v_row           RECORD;
    v_trace_part    TEXT;
    v_product_part  TEXT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;

    IF v_order.id IS NULL OR v_order.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status NOT IN ('confirmed', 'shipping') THEN
        RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE:%', v_order.status;
    END IF;

    v_trace_no := upper(btrim(COALESCE(p_trace_no, '')));

    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id
          AND event_type = 'OUTBOUND_UNASSIGN'
    ) THEN
        FOR v_row IN
            SELECT product_id, inbound_scan_id, qty_delta
            FROM public.stock_ledger
            WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_OUT'
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
                v_wholesaler_id, v_row.product_id, v_row.inbound_scan_id, -v_row.qty_delta,
                'OUTBOUND_UNASSIGN', 'order', p_order_id, '출고 스캔으로 배정 정정', auth.uid()
            );
        END LOOP;
    END IF;

    SELECT * INTO v_box
    FROM public.inbound_scans
    WHERE wholesaler_id = v_wholesaler_id
      AND trace_no = v_trace_no
      AND status = 'NORMAL'
      AND remaining_weight > 0
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;

    IF v_box.id IS NULL THEN
        RAISE EXCEPTION 'BOX_NOT_AVAILABLE';
    END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO v_ordered
    FROM public.order_items
    WHERE order_id = p_order_id AND product_id = v_box.product_id;

    IF v_ordered <= 0 THEN
        RAISE EXCEPTION 'PRODUCT_NOT_IN_ORDER';
    END IF;

    SELECT COALESCE(SUM(-qty_delta), 0) INTO v_assigned
    FROM public.stock_ledger
    WHERE source_type = 'order' AND source_id = p_order_id
      AND event_type = 'OUTBOUND_ASSIGN'
      AND product_id = v_box.product_id;

    v_needed := v_ordered - v_assigned;

    IF v_needed <= 0 THEN
        RAISE EXCEPTION 'PRODUCT_ALREADY_FULFILLED';
    END IF;

    v_take := LEAST(v_box.remaining_weight, v_needed, COALESCE(p_weight, v_box.remaining_weight));

    IF v_take <= 0 THEN
        RAISE EXCEPTION 'INVALID_WEIGHT';
    END IF;

    UPDATE public.inbound_scans
    SET remaining_weight = remaining_weight - v_take
    WHERE id = v_box.id;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, created_by
    ) VALUES (
        v_wholesaler_id, v_box.product_id, v_box.id, -v_take,
        'OUTBOUND_ASSIGN', 'order', p_order_id, auth.uid()
    );

    PERFORM public.recalc_product_stock(v_box.product_id);

    -- 부위 대조 (막지 않고 알리기만 한다, 설계 결정 1번)
    SELECT part_name INTO v_trace_part FROM public.master_livestock WHERE trace_no = v_trace_no;
    SELECT subcategory INTO v_product_part FROM public.products WHERE id = v_box.product_id;

    RETURN jsonb_build_object(
        'trace_no', v_trace_no,
        'product_id', v_box.product_id,
        'product_name', (SELECT name FROM public.products WHERE id = v_box.product_id),
        'taken', v_take,
        'ordered', v_ordered,
        'assigned', v_assigned + v_take,
        'remaining_needed', v_needed - v_take,
        'part_mismatch', public.parts_conflict(v_trace_part, v_product_part),
        'trace_part', v_trace_part,
        'product_part', v_product_part
    );
END;
$$;
