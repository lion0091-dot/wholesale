-- ====================================================================
-- 출고 스캔 — 실제로 집은 박스로 배정을 정정한다
--
-- 주문을 확정하면 apply_order_shipment()가 선입선출로 박스를 골라 차감한다.
-- 그런데 그건 어디까지나 "추정"이다 — 현장 작업자가 실제로 집는 박스는 다를 수
-- 있고, 그러면 장부와 실물이 어긋난다. 거래처에 "이 이력번호 고기를 드렸다"고
-- 말할 근거도 사라진다.
--
-- 그래서 나갈 때도 박스를 찍는다. 첫 출고 스캔이 들어오면 그 주문의 자동 배정을
-- 통째로 되돌리고(OUTBOUND_UNASSIGN), 찍은 박스로 다시 배정한다(OUTBOUND_ASSIGN).
-- 수량 총합은 그대로고 "어느 박스였나"만 사실로 바뀐다.
--
-- 잠긴 설계 결정:
--
--  1. 원장은 고쳐 쓰지 않고 되돌림+재기록으로 표현한다. 기존 행을 UPDATE하면
--     "언제 무엇이 바뀌었나"가 사라진다.
--
--  2. 되돌림은 주문당 한 번만 한다. 두 번째 박스를 찍을 때 또 되돌리면 앞서
--     스캔한 배정까지 풀려버린다.
--
--  3. 주문에 없는 상품의 박스는 거부한다. 엉뚱한 박스를 찍었을 때 조용히
--     넘어가면 재고가 틀어진다.
--
--  4. 주문 수량을 넘겨 배정하지 않는다. 남은 필요량까지만 가져간다.
-- ====================================================================

-- 원장 이벤트 두 개 추가.
ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_event_type_check;

ALTER TABLE public.stock_ledger ADD CONSTRAINT stock_ledger_event_type_check
    CHECK (event_type IN (
        'INBOUND', 'INBOUND_VOID',
        'OPENING_BALANCE',
        'ORDER_OUT', 'ORDER_RESTORE',
        -- 출고 스캔: 자동 배정 되돌림(+) / 실제 박스 배정(-)
        'OUTBOUND_UNASSIGN', 'OUTBOUND_ASSIGN',
        'ADJUSTMENT', 'LOSS'
    ));


/**
 * 출고 스캔 1건.
 *
 * p_weight가 NULL이면 그 박스의 잔량을 다 쓰되, 주문에 남은 필요량을 넘지 않는다.
 */
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
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;

    IF v_order.id IS NULL OR v_order.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- 아직 확정 전이거나 이미 끝난 주문은 출고할 게 없다.
    IF v_order.status NOT IN ('confirmed', 'shipping') THEN
        RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE:%', v_order.status;
    END IF;

    v_trace_no := upper(btrim(COALESCE(p_trace_no, '')));

    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    -- (1) 첫 출고 스캔이면 자동 배정을 통째로 되돌린다 (설계 결정 2번).
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

    -- (2) 찍은 박스 찾기
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

    -- (3) 이 주문에 그 상품이 있는지 (설계 결정 3번)
    SELECT COALESCE(SUM(quantity), 0) INTO v_ordered
    FROM public.order_items
    WHERE order_id = p_order_id AND product_id = v_box.product_id;

    IF v_ordered <= 0 THEN
        RAISE EXCEPTION 'PRODUCT_NOT_IN_ORDER';
    END IF;

    -- (4) 이미 배정된 양과 남은 필요량 (설계 결정 4번)
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

    RETURN jsonb_build_object(
        'trace_no', v_trace_no,
        'product_id', v_box.product_id,
        'product_name', (SELECT name FROM public.products WHERE id = v_box.product_id),
        'taken', v_take,
        'ordered', v_ordered,
        'assigned', v_assigned + v_take,
        'remaining_needed', v_needed - v_take
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_outbound_scan(UUID, TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_outbound_scan(UUID, TEXT, NUMERIC) TO authenticated;


-- 주문별 출고 진행 상황 — 화면에서 "얼마나 찍었나"를 보여준다.
CREATE OR REPLACE FUNCTION public.get_outbound_progress(p_order_id UUID)
RETURNS TABLE (
    product_id   UUID,
    product_name TEXT,
    unit         TEXT,
    ordered_qty  NUMERIC,
    scanned_qty  NUMERIC,
    trace_nos    TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        i.product_id,
        MAX(i.product_name),
        MAX(p.unit),
        SUM(i.quantity),
        COALESCE((
            SELECT SUM(-l.qty_delta)
            FROM public.stock_ledger l
            WHERE l.source_type = 'order' AND l.source_id = p_order_id
              AND l.event_type = 'OUTBOUND_ASSIGN'
              AND l.product_id = i.product_id
        ), 0),
        (
            SELECT string_agg(DISTINCT s.trace_no, ', ')
            FROM public.stock_ledger l
            JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
            WHERE l.source_type = 'order' AND l.source_id = p_order_id
              AND l.event_type = 'OUTBOUND_ASSIGN'
              AND l.product_id = i.product_id
        )
    FROM public.order_items i
    JOIN public.orders o ON o.id = i.order_id
    LEFT JOIN public.products p ON p.id = i.product_id
    WHERE i.order_id = p_order_id
      AND (
            public.can_access_wholesaler(o.wholesaler_id)
      )
    GROUP BY i.product_id;
$$;

REVOKE EXECUTE ON FUNCTION public.get_outbound_progress(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_outbound_progress(UUID) TO authenticated;


-- 거래명세서에 찍을 이력번호는 이제 실제 스캔분을 우선한다.
CREATE OR REPLACE FUNCTION public.get_order_trace_numbers(p_order_id UUID)
RETURNS TABLE (
    product_id     UUID,
    product_name   TEXT,
    trace_no       TEXT,
    quantity       NUMERIC,
    grade          TEXT,
    slaughter_date DATE,
    butchery_place TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        l.product_id,
        p.name,
        s.trace_no,
        -l.qty_delta,
        m.grade,
        m.slaughter_date,
        m.butchery_place
    FROM public.stock_ledger l
    JOIN public.orders o          ON o.id = l.source_id
    JOIN public.inbound_scans s   ON s.id = l.inbound_scan_id
    JOIN public.products p        ON p.id = l.product_id
    LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
    WHERE l.source_type = 'order'
      AND l.source_id = p_order_id
      AND l.inbound_scan_id IS NOT NULL
      -- 출고 스캔이 있었으면 그것만, 없으면 자동 배정분을 쓴다.
      AND l.event_type = CASE
            WHEN EXISTS (
                SELECT 1 FROM public.stock_ledger x
                WHERE x.source_type = 'order' AND x.source_id = p_order_id
                  AND x.event_type = 'OUTBOUND_ASSIGN'
            ) THEN 'OUTBOUND_ASSIGN'
            ELSE 'ORDER_OUT'
          END
      AND (
            o.wholesaler_id = public.get_current_wholesaler_id()
         OR public.is_org_staff_of_wholesaler(o.wholesaler_id)
         OR o.retailer_id = public.get_current_retailer_id()
         OR public.get_current_role() = 'super_admin'
      )
    ORDER BY p.name, s.trace_no;
$$;

REVOKE EXECUTE ON FUNCTION public.get_order_trace_numbers(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_order_trace_numbers(UUID) TO authenticated;


-- 기간 요약의 "출고"에 출고 스캔분을 포함시킨다. 빠뜨리면 스캔으로 나간 양이
-- 어느 칸에도 안 잡혀 합계가 안 맞는다.
CREATE OR REPLACE FUNCTION public.summarize_stock_ledger(
    p_wholesaler_id UUID,
    p_from          DATE DEFAULT NULL,
    p_to            DATE DEFAULT NULL,
    p_product_id    UUID DEFAULT NULL,
    p_trace_no      TEXT DEFAULT NULL
)
RETURNS TABLE (
    inbound_qty    NUMERIC,
    outbound_qty   NUMERIC,
    adjustment_qty NUMERIC,
    loss_qty       NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN ('INBOUND', 'INBOUND_VOID', 'OPENING_BALANCE')), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN (
            'ORDER_OUT', 'ORDER_RESTORE', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN'
        )), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'ADJUSTMENT'), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'LOSS'), 0)
    FROM public.stock_ledger l
    LEFT JOIN public.inbound_scans scan ON scan.id = l.inbound_scan_id
    WHERE l.wholesaler_id = p_wholesaler_id
      AND (p_from IS NULL OR l.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR l.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR l.product_id = p_product_id)
      AND (
            NULLIF(btrim(p_trace_no), '') IS NULL
         OR scan.trace_no ILIKE '%' || btrim(p_trace_no) || '%'
      )
      AND (
            public.can_access_wholesaler(p_wholesaler_id)
      );
$$;

REVOKE EXECUTE ON FUNCTION public.summarize_stock_ledger(UUID, DATE, DATE, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summarize_stock_ledger(UUID, DATE, DATE, UUID, TEXT) TO authenticated;


-- 소분 라벨에 찍을 정보 — 출고된 박스별로 한 줄.
-- get_order_trace_numbers()와 달리 공급사 정보와 원산지까지 함께 준다.
CREATE OR REPLACE FUNCTION public.get_order_labels(p_order_id UUID)
RETURNS TABLE (
    product_name   TEXT,
    trace_no       TEXT,
    quantity       NUMERIC,
    unit           TEXT,
    grade          TEXT,
    origin         TEXT,
    slaughter_date DATE,
    packing_date   DATE,
    butchery_place TEXT,
    supplier_name  TEXT,
    order_number   TEXT,
    retailer_name  TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        p.name,
        s.trace_no,
        -l.qty_delta,
        p.unit,
        COALESCE(m.grade, p.grade),
        p.origin,
        m.slaughter_date,
        m.packing_date,
        m.butchery_place,
        w.business_name,
        o.order_number,
        r.restaurant_name
    FROM public.stock_ledger l
    JOIN public.orders o          ON o.id = l.source_id
    JOIN public.wholesalers w     ON w.id = o.wholesaler_id
    JOIN public.retailers r       ON r.id = o.retailer_id
    JOIN public.inbound_scans s   ON s.id = l.inbound_scan_id
    JOIN public.products p        ON p.id = l.product_id
    LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
    WHERE l.source_type = 'order'
      AND l.source_id = p_order_id
      AND l.inbound_scan_id IS NOT NULL
      -- 출고 스캔이 있었으면 그것만, 없으면 자동 배정분을 쓴다.
      AND l.event_type = CASE
            WHEN EXISTS (
                SELECT 1 FROM public.stock_ledger x
                WHERE x.source_type = 'order' AND x.source_id = p_order_id
                  AND x.event_type = 'OUTBOUND_ASSIGN'
            ) THEN 'OUTBOUND_ASSIGN'
            ELSE 'ORDER_OUT'
          END
      AND (
            public.can_access_wholesaler(o.wholesaler_id)
      )
    ORDER BY p.name, s.trace_no;
$$;

REVOKE EXECUTE ON FUNCTION public.get_order_labels(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_order_labels(UUID) TO authenticated;
