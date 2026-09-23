-- 확보 대기 주문에 입고 즉시 배정 — 재고 이중 차감 막기 (31단계)
--
-- 31단계에서 '확보 대기'(awaiting_stock)를 열었지만, 입고 즉시 배정(27단계)과는
-- 잇지 않고 남겨뒀다. 그대로 이으면 **재고가 두 번 빠지기 때문이다.**
--
-- 왜 두 번 빠지나:
--   record_outbound_scan은 "이미 확정돼 ORDER_OUT 행이 있는 주문"을 전제로 만들어졌다.
--   그 자동 차감을 OUTBOUND_UNASSIGN으로 되돌린 뒤, 실제로 찍은 박스를
--   OUTBOUND_ASSIGN으로 붙인다. 확정을 거치지 않은 awaiting_stock 주문에는 되돌릴
--   ORDER_OUT이 없으므로 ASSIGN만 쌓인다. 그 뒤 주문을 confirmed로 넘기면
--   apply_order_shipment의 멱등 가드가 "ORDER_OUT이 있나"만 보기 때문에 그냥
--   통과해서 **주문 수량 전체를 한 번 더 차감한다.**
--
-- 고치는 방향: 멱등 판정을 이벤트 종류가 아니라 **상품별 순 출고량**으로 바꾼다.
-- 이미 배정된 만큼은 빼고 모자란 분량만 채운다. 이러면 확정 전에 일부만 찍혀
-- 있어도, 전혀 안 찍혀 있어도, 전부 찍혀 있어도 같은 결과가 나온다.


-- --------------------------------------------------------------------
-- 1. apply_order_shipment — 이미 빠져나간 만큼은 빼고 모자란 분량만 차감
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
    v_remaining NUMERIC(10, 3);
    v_take      NUMERIC(10, 3);
    v_available NUMERIC(10, 3);
    v_already   NUMERIC(10, 3);
BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
    IF v_order.id IS NULL THEN
        RETURN;
    END IF;

    -- 예전의 "ORDER_OUT이 하나라도 있으면 통째로 건너뛴다" 가드는 없앴다.
    -- 출고 스캔이 ORDER_OUT 없이 OUTBOUND_ASSIGN만 남기는 경우(확보 대기 주문)를
    -- 그 가드가 못 잡아 이중 차감이 났다. 상품별 순량으로 판정하면 그 가드가
    -- 하던 일(재확정 시 중복 차감 방지)까지 함께 커버된다.
    FOR v_item IN
        SELECT product_id, SUM(quantity) AS quantity, MAX(product_name) AS product_name
        FROM public.order_items
        WHERE order_id = p_order_id
        GROUP BY product_id
    LOOP
        -- 이 주문·이 상품으로 이미 빠져나간 순량.
        -- 차감은 음수, 되돌림은 양수라 합계에 부호를 뒤집으면 "이미 나간 양"이 된다.
        SELECT COALESCE(-SUM(qty_delta), 0) INTO v_already
        FROM public.stock_ledger
        WHERE source_type = 'order'
          AND source_id = p_order_id
          AND product_id = v_item.product_id
          AND event_type IN ('ORDER_OUT', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN', 'ORDER_RESTORE');

        v_remaining := v_item.quantity - v_already;

        -- 이미 다 나갔으면 이 상품은 할 일이 없다.
        IF v_remaining <= 0 THEN
            CONTINUE;
        END IF;

        -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 기초재고로 옮긴다.
        PERFORM public.ensure_opening_balance(v_item.product_id);

        SELECT COALESCE(SUM(qty_delta), 0) INTO v_available
        FROM public.stock_ledger WHERE product_id = v_item.product_id;

        -- 모자란 분량 기준으로 본다. 주문 전체 수량으로 보면 이미 찍어둔 주문이
        -- 재고 부족으로 잘못 막힌다.
        IF v_available < v_remaining THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
                v_item.product_name, v_available, v_remaining;
        END IF;

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

REVOKE EXECUTE ON FUNCTION public.apply_order_shipment(UUID) FROM PUBLIC;


-- --------------------------------------------------------------------
-- 2. reverse_order_shipment — 배정만 된 주문도 원복한다
-- --------------------------------------------------------------------
-- 본문 루프는 이미 ORDER_OUT/ASSIGN/UNASSIGN을 박스별로 합산해 되돌리고 있어
-- 손댈 게 없다. 문제는 초입 가드다 — "ORDER_OUT이 없으면 할 일 없다"고 판단해
-- 그냥 나가버려서, 확정을 거치지 않고 배정만 된 확보 대기 주문을 취소하면
-- 재고가 빠진 채로 남는다.
CREATE OR REPLACE FUNCTION public.reverse_order_shipment(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row RECORD;
BEGIN
    -- 나간 적이 없으면(예: 접수대기에서 바로 취소) 할 일이 없다.
    -- 배정만 된 경우(OUTBOUND_ASSIGN)도 나간 것으로 본다.
    IF NOT EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id
          AND event_type IN ('ORDER_OUT', 'OUTBOUND_ASSIGN')
    ) THEN
        RETURN;
    END IF;

    -- 이미 원복된 주문이면 건너뛴다.
    IF EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_RESTORE'
    ) THEN
        RETURN;
    END IF;

    -- 출고 스캔이 자동 배정을 되돌리고(OUTBOUND_UNASSIGN) 실제 집은 박스로
    -- 재배정(OUTBOUND_ASSIGN)했을 수 있으므로 박스별 순 출고량을 되돌린다.
    FOR v_row IN
        SELECT wholesaler_id, product_id, inbound_scan_id, SUM(qty_delta) AS qty_delta
        FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id
          AND event_type IN ('ORDER_OUT', 'OUTBOUND_UNASSIGN', 'OUTBOUND_ASSIGN')
        GROUP BY wholesaler_id, product_id, inbound_scan_id
        HAVING SUM(qty_delta) <> 0
    LOOP
        IF v_row.inbound_scan_id IS NOT NULL THEN
            -- 그 사이 폐기(VOIDED)된 박스는 잔량을 되돌리지 않고 원장에만 남긴다.
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
-- 3. 출고 스캔이 확보 대기 주문도 받는다
-- --------------------------------------------------------------------
-- 아래는 현재 DB에 있는 record_outbound_scan 정의를 그대로 가져와 상태 검사
-- 한 줄만 고친 것이다. 함수가 길고 중복 판정·배정 정정이 얽혀 있어 새로
-- 쓰면 실수가 나기 쉬워서, 실제 정의(pg_get_functiondef)를 떠서 패치했다.

CREATE OR REPLACE FUNCTION public.record_outbound_scan(p_order_id uuid, p_trace_no text, p_weight numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

    -- 확보 대기(awaiting_stock)도 받는다. 물건이 아직 없는 주문이라 오히려
    -- 입고하면서 바로 붙일 대상이다. 이중 차감은 apply_order_shipment가
    -- 상품별 순 출고량으로 판정하도록 고쳐서 막았다(31단계).
    IF v_order.status NOT IN ('awaiting_stock', 'confirmed', 'shipping') THEN
        RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE:%', v_order.status;
    END IF;

    v_trace_no := upper(btrim(COALESCE(p_trace_no, '')));

    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
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

    -- 기한이 지난 박스는 내보내지 않는다 (설계 결정 2번). 부위 불일치와 달리
    -- 판단의 여지가 없어 확인 버튼으로 넘기게 두지 않는다.
    IF v_box.best_before IS NOT NULL AND v_box.best_before < CURRENT_DATE THEN
        RAISE EXCEPTION 'BOX_EXPIRED:%', to_char(v_box.best_before, 'YYYY-MM-DD');
    END IF;

    -- 이 상품이 이 주문에서 처음 스캔되는 거면, 그 상품의 자동 배정만 되돌린다.
    -- 주문 전체를 되돌리면(구버전) 아직 안 찍은 다른 상품의 ORDER_OUT 행까지
    -- 지워져서, 부분 스캔 상태의 명세서·마감 계산이 그 상품을 출고 0으로 본다.
    IF NOT EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id
          AND event_type = 'OUTBOUND_UNASSIGN'
          AND product_id = v_box.product_id
    ) THEN
        FOR v_row IN
            SELECT product_id, inbound_scan_id, qty_delta
            FROM public.stock_ledger
            WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_OUT'
              AND product_id = v_box.product_id
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
        'best_before',  v_box.best_before,
        'days_left',    v_box.best_before - CURRENT_DATE,
        'part_mismatch', public.parts_conflict(v_trace_part, v_product_part),
        'trace_part', v_trace_part,
        'product_part', v_product_part
    );
END;
$function$;
