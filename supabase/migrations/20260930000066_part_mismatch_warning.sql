-- ====================================================================
-- 부위 불일치 경고 — 매핑 오류가 출고까지 번지는 걸 잡는다
--
-- 입고 때 박스를 엉뚱한 상품에 매핑하면 그 뒤로는 아무도 못 잡는다. 출고 스캔은
-- "주문에 있는 상품인가"만 보므로, 채끝 박스가 등심 상품에 매핑돼 있으면
-- 등심 주문에 그대로 통과한다 — 식당에는 채끝이 간다.
--
-- 박스의 이력 정보에는 진짜 부위가 들어 있다. 그걸 상품의 부위(subcategory)와
-- 대조하면 잡을 수 있다.
--
-- 잠긴 설계 결정:
--
--  1. 막지 않고 경고만 한다. 부위 표기가 API와 우리 분류에서 다를 수 있고
--     ("채끝등심" vs "채끝"), 실제로는 맞는데 막으면 현장이 멈춘다.
--
--  2. 서로 포함 관계면 일치로 본다. 표기 차이로 헛경고가 쏟아지면 아무도
--     경고를 안 읽게 된다 — 그게 경고가 없는 것보다 나쁘다.
--
--  3. 한쪽이라도 모르면 경고하지 않는다. 이력에 부위가 없는 경우가 흔한데
--     그때마다 경고하면 소음만 된다.
-- ====================================================================

/**
 * 두 부위 표기가 "서로 다른 부위"라고 볼 만한지.
 * 모르거나 포함 관계면 false(문제 없음).
 */
CREATE OR REPLACE FUNCTION public.parts_conflict(p_left TEXT, p_right TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN NULLIF(btrim(COALESCE(p_left, '')), '') IS NULL THEN false
        WHEN NULLIF(btrim(COALESCE(p_right, '')), '') IS NULL THEN false
        ELSE NOT (
            -- 공백을 없애고 서로 포함하는지 본다 (설계 결정 2번).
            replace(btrim(p_left), ' ', '') LIKE '%' || replace(btrim(p_right), ' ', '') || '%'
         OR replace(btrim(p_right), ' ', '') LIKE '%' || replace(btrim(p_left), ' ', '') || '%'
        )
    END;
$$;


-- (1) 출고 스캔 — 찍은 박스의 이력 부위와 상품 부위를 대조한다.
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
    v_ordered       NUMERIC(10, 2);
    v_assigned      NUMERIC(10, 2);
    v_needed        NUMERIC(10, 2);
    v_take          NUMERIC(10, 2);
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

REVOKE EXECUTE ON FUNCTION public.record_outbound_scan(UUID, TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_outbound_scan(UUID, TEXT, NUMERIC) TO authenticated;


-- (2) 입고 스캔 — 사용자가 상품을 직접 고른 경우에만 대조한다.
--     학습된 매핑으로 자동 연결된 건은 이미 한 번 사람이 확인한 결과다.
CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping(
    p_scan_id    UUID,
    p_product_id UUID,
    p_remember   BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_master        public.master_livestock%ROWTYPE;
    v_product_part  TEXT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status NOT IN ('PENDING_MAPPING', 'EXCEPTION') THEN
        RAISE EXCEPTION 'SCAN_ALREADY_RESOLVED';
    END IF;

    PERFORM 1 FROM public.products
    WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    UPDATE public.inbound_scans
    SET product_id = p_product_id,
        status = 'NORMAL',
        remaining_weight = weight
    WHERE id = p_scan_id;

    PERFORM public.ensure_opening_balance(p_product_id);

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, created_by
    ) VALUES (
        v_wholesaler_id, p_product_id, p_scan_id, v_scan.weight,
        'INBOUND', 'inbound_scan', p_scan_id, auth.uid()
    );

    PERFORM public.recalc_product_stock(p_product_id);

    UPDATE public.livestock_exception_log
    SET resolved_status = 'RESOLVED',
        resolved_by = auth.uid(),
        resolved_at = now()
    WHERE inbound_scan_id = p_scan_id AND resolved_status = 'PENDING';

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_scan.trace_no;
    SELECT subcategory INTO v_product_part FROM public.products WHERE id = p_product_id;

    IF p_remember THEN
        IF v_master.part_name IS NOT NULL AND v_master.species_group IS NOT NULL THEN
            INSERT INTO public.trace_product_map (
                wholesaler_id, species_group, part_name, grade, product_id, created_by
            ) VALUES (
                v_wholesaler_id, v_master.species_group, v_master.part_name,
                v_master.grade, p_product_id, auth.uid()
            )
            ON CONFLICT (wholesaler_id, species_group, part_name, COALESCE(grade, ''))
            DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now();
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'scan_id', p_scan_id,
        'status', 'NORMAL',
        'product_id', p_product_id,
        'part_mismatch', public.parts_conflict(v_master.part_name, v_product_part),
        'trace_part', v_master.part_name,
        'product_part', v_product_part
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_inbound_mapping(UUID, UUID, BOOLEAN) TO authenticated;
