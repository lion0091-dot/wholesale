-- ====================================================================
-- 유통기한 — 바코드가 주는데 버리고 있었다
--
-- GS1-128 계량 바코드에는 유통기한(AI 17)과 품질유지기한(AI 15)이 실려 온다.
-- 파서는 그걸 bestBefore 로 이미 읽어내고 있었는데, 저장할 컬럼이 없어
-- 그대로 버려졌다. 기한이 지난 박스가 창고에 있어도 아무도 모르고,
-- 선입선출은 "입고순"이라 기한이 임박한 박스를 우선 빼주지도 않는다.
--
-- 잠긴 설계 결정:
--
--  1. 유통기한은 master_livestock 이 아니라 inbound_scans 에 둔다 —
--     박스 속성이지 이력번호 속성이 아니다. 같은 이력번호라도 가공·포장
--     시점이 다르면 기한이 다르다. (포장일 packing_date 가 master 에 있는
--     건 그게 공공 API 에서 오는 이력 정보라서다. 유통기한은 API 가 주지
--     않고 바코드에만 있다.)
--
--  2. 기한이 지난 박스는 출고를 막는다. 부위 불일치는 표기 차이로 헛경고가
--     날 수 있어 경고만 했지만, 기한 경과는 판단의 여지가 없고 식품위생법
--     위반이다. 확인 버튼으로 넘길 수 있게 만들면 안 된다.
--
--  3. 입고는 막지 않는다. 이미 지난 물건이 들어왔다면 그 사실을 기록해야
--     반품·폐기 처리가 된다. 스캔을 거부하면 장부에 아무것도 안 남는다.
--
--  4. 피킹 순서는 입고순(FIFO)을 유지하고 기한은 표시만 한다. 기한순
--     출고(FEFO)로 바꾸는 건 별개의 큰 변경이라 여기서 섞지 않는다.
--     대부분의 경우 입고순과 기한순은 같다.
-- ====================================================================

ALTER TABLE public.inbound_scans
    ADD COLUMN IF NOT EXISTS best_before DATE;

CREATE INDEX IF NOT EXISTS idx_inbound_scans_best_before
    ON public.inbound_scans (wholesaler_id, best_before)
    WHERE best_before IS NOT NULL AND status = 'NORMAL';


-- 입고 스캔이 유통기한을 받는다. 파라미터가 늘어 시그니처가 바뀐다.
CREATE OR REPLACE FUNCTION public.record_inbound_scan(
    p_trace_no          TEXT,
    p_weight            NUMERIC,
    p_scan_type         TEXT,
    p_product_id        UUID DEFAULT NULL,
    p_fail_reason       TEXT DEFAULT NULL,
    p_import_row_id     UUID DEFAULT NULL,
    p_memo              TEXT DEFAULT NULL,
    p_confirm_duplicate BOOLEAN DEFAULT false,
    p_best_before       DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result JSONB;
    v_scan_id UUID;
BEGIN
    -- 기존 로직은 그대로 쓰고, 유통기한만 뒤에 붙인다. 스캔 본문을 통째로
    -- 다시 쓰면 중복 감지·자동 매핑 같은 규칙을 또 복제하게 된다.
    v_result := public.record_inbound_scan_base(
        p_trace_no, p_weight, p_scan_type, p_product_id,
        p_fail_reason, p_import_row_id, p_memo, p_confirm_duplicate
    );

    v_scan_id := NULLIF(v_result ->> 'scan_id', '')::UUID;

    IF v_scan_id IS NOT NULL AND p_best_before IS NOT NULL THEN
        UPDATE public.inbound_scans
        SET best_before = p_best_before
        WHERE id = v_scan_id;

        v_result := v_result || jsonb_build_object(
            'best_before', p_best_before,
            'days_left',   p_best_before - CURRENT_DATE,
            -- 이미 지난 물건도 받아는 준다 (설계 결정 3번). 대신 알린다.
            'expired',     p_best_before < CURRENT_DATE
        );
    END IF;

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, DATE
) TO authenticated;


-- 기존 8개짜리 본문을 _base 로 옮긴다. 호출 모호성을 없애려 원래 이름의
-- 8개짜리는 아래에서 지운다.
CREATE OR REPLACE FUNCTION public.record_inbound_scan_base(
    p_trace_no          TEXT,
    p_weight            NUMERIC,
    p_scan_type         TEXT,
    p_product_id        UUID DEFAULT NULL,
    p_fail_reason       TEXT DEFAULT NULL,
    p_import_row_id     UUID DEFAULT NULL,
    p_memo              TEXT DEFAULT NULL,
    -- 작업자가 "다른 박스가 맞다"고 확인하면 true로 다시 호출한다.
    p_confirm_duplicate BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_trace_no      TEXT;
    v_master        public.master_livestock%ROWTYPE;
    v_product_id    UUID;
    v_status        TEXT;
    v_scan_id       UUID;
    v_reason        TEXT;
    v_dup_at        TIMESTAMPTZ;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    IF p_weight IS NULL OR p_weight <= 0 THEN
        RAISE EXCEPTION 'INVALID_WEIGHT';
    END IF;

    v_trace_no := upper(trim(COALESCE(p_trace_no, '')));
    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    -- 중복 의심 검사 — 엑셀 일괄 업로드는 대상에서 뺀다(같은 파일 안에 같은
    -- 규격이 여러 줄 있는 게 정상이고, 행마다 확인창을 띄울 수도 없다).
    IF NOT p_confirm_duplicate AND p_scan_type <> 'EXCEL' THEN
        SELECT created_at INTO v_dup_at
        FROM public.inbound_scans
        WHERE wholesaler_id = v_wholesaler_id
          AND trace_no = v_trace_no
          AND weight = p_weight
          -- 재고에 실제로 반영된 스캔만 본다. 검증 실패(EXCEPTION)나 매핑 대기
          -- (PENDING_MAPPING) 건을 다시 찍는 건 중복이 아니라 재시도이고,
          -- 취소(VOIDED)된 건은 이미 재고에서 빠졌다. 중복 스캔이 문제가 되는
          -- 경우는 재고가 부풀 때뿐이다.
          AND status = 'NORMAL'
          AND created_at > now() - public.duplicate_scan_window()
        ORDER BY created_at DESC
        LIMIT 1;

        IF v_dup_at IS NOT NULL THEN
            RAISE EXCEPTION 'DUPLICATE_SUSPECTED:%', to_char(v_dup_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI');
        END IF;
    END IF;

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_trace_no;

    IF p_product_id IS NOT NULL THEN
        SELECT id INTO v_product_id
        FROM public.products
        WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;

        IF v_product_id IS NULL THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
        END IF;

    ELSIF v_master.trace_no IS NOT NULL AND v_master.part_name IS NOT NULL THEN
        SELECT product_id INTO v_product_id
        FROM public.trace_product_map
        WHERE wholesaler_id = v_wholesaler_id
          AND species_group = v_master.species_group
          AND part_name = v_master.part_name
          AND (grade IS NULL OR grade = v_master.grade)
        ORDER BY grade NULLS LAST
        LIMIT 1;
    END IF;

    IF v_master.trace_no IS NULL THEN
        v_status := 'EXCEPTION';
        v_reason := COALESCE(p_fail_reason, 'NOT_FOUND');
    ELSIF v_product_id IS NULL THEN
        v_status := 'PENDING_MAPPING';
        v_reason := 'UNMAPPED_PRODUCT';
    ELSE
        v_status := 'NORMAL';
        v_reason := NULL;
    END IF;

    INSERT INTO public.inbound_scans (
        wholesaler_id, trace_no, product_id, weight, scan_type, status,
        remaining_weight, import_row_id, memo, scanned_by
    ) VALUES (
        v_wholesaler_id, v_trace_no, v_product_id, p_weight, p_scan_type, v_status,
        CASE WHEN v_status = 'NORMAL' THEN p_weight ELSE 0 END,
        p_import_row_id, p_memo, auth.uid()
    )
    RETURNING id INTO v_scan_id;

    IF v_status = 'NORMAL' THEN
        PERFORM public.ensure_opening_balance(v_product_id);

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, created_by
        ) VALUES (
            v_wholesaler_id, v_product_id, v_scan_id, p_weight,
            'INBOUND', 'inbound_scan', v_scan_id, auth.uid()
        );

        PERFORM public.recalc_product_stock(v_product_id);
    ELSE
        INSERT INTO public.livestock_exception_log (
            wholesaler_id, inbound_scan_id, raw_input, reason, detail
        ) VALUES (
            v_wholesaler_id, v_scan_id, v_trace_no, v_reason,
            CASE WHEN v_status = 'PENDING_MAPPING'
                 THEN '이력 조회는 성공했으나 상품 매핑이 확정되지 않았습니다.'
                 ELSE NULL END
        );
    END IF;

    RETURN jsonb_build_object(
        'scan_id',        v_scan_id,
        'trace_no',       v_trace_no,
        'status',         v_status,
        'product_id',     v_product_id,
        'master_found',   v_master.trace_no IS NOT NULL,
        'species_group',  v_master.species_group,
        'part_name',      v_master.part_name,
        'grade',          v_master.grade,
        'slaughter_date', v_master.slaughter_date,
        'packing_date',   v_master.packing_date
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_inbound_scan_base(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_inbound_scan_base(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN
) TO authenticated;

DROP FUNCTION IF EXISTS public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN
);


-- 출고 스캔이 유통기한을 본다.
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
$$;

/**
 * 유통기한 임박/경과 재고.
 *
 * p_days 이내로 남았거나 이미 지난 박스를 기한이 급한 순으로 준다.
 * 기한이 없는 박스(바코드에 안 실려 온 경우)는 대상이 아니다.
 */
CREATE OR REPLACE FUNCTION public.get_expiring_boxes(p_days INTEGER DEFAULT 3)
RETURNS TABLE (
    box_id           UUID,
    trace_no         TEXT,
    product_id       UUID,
    product_name     TEXT,
    unit             TEXT,
    remaining_weight NUMERIC,
    best_before      DATE,
    days_left        INTEGER,
    expired          BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        s.id,
        s.trace_no,
        s.product_id,
        p.name,
        COALESCE(p.unit, 'kg'),
        s.remaining_weight,
        s.best_before,
        (s.best_before - CURRENT_DATE)::INTEGER,
        s.best_before < CURRENT_DATE
    FROM public.inbound_scans s
    LEFT JOIN public.products p ON p.id = s.product_id
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
      AND s.best_before IS NOT NULL
      AND s.best_before - CURRENT_DATE <= COALESCE(p_days, 3)
    ORDER BY s.best_before, s.created_at;
$$;

REVOKE EXECUTE ON FUNCTION public.get_expiring_boxes(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expiring_boxes(INTEGER) TO authenticated;


-- 피킹 목록이 유통기한을 함께 보여준다 (표시만 — 순서는 입고순 유지, 설계 결정 4번).
-- 반환 컬럼이 늘어 REPLACE 가 안 된다.
DROP FUNCTION IF EXISTS public.get_picking_list(UUID);

CREATE OR REPLACE FUNCTION public.get_picking_list(p_order_id UUID)
RETURNS TABLE (
    product_id     UUID,
    product_name   TEXT,
    unit           TEXT,
    box_id         UUID,
    trace_no       TEXT,
    suggested_qty  NUMERIC,
    box_weight     NUMERIC,
    grade          TEXT,
    slaughter_date DATE,
    scanned_at     TIMESTAMPTZ,
    already_picked BOOLEAN,
    best_before    DATE,
    days_left      INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH authorized AS (
        SELECT o.id, o.wholesaler_id
        FROM public.orders o
        WHERE o.id = p_order_id
          AND (
                public.can_access_wholesaler(o.wholesaler_id)
          )
    ),
    scan_started AS (
        SELECT EXISTS (
            SELECT 1 FROM public.stock_ledger
            WHERE source_type = 'order' AND source_id = p_order_id
              AND event_type = 'OUTBOUND_ASSIGN'
        ) AS started
    ),
    -- (A) 스캔 전 — 확정 때 잡아둔 선입선출 배정이 곧 추천이다.
    from_auto AS (
        SELECT
            l.product_id,
            p.name AS product_name,
            p.unit,
            s.id AS box_id,
            s.trace_no,
            -l.qty_delta AS suggested_qty,
            s.weight AS box_weight,
            m.grade,
            m.slaughter_date,
            s.created_at AS scanned_at,
            false AS already_picked,
            s.best_before,
            (s.best_before - CURRENT_DATE)::INTEGER
        FROM public.stock_ledger l
        JOIN authorized a ON a.id = l.source_id
        JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
        JOIN public.products p ON p.id = l.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
        WHERE l.source_type = 'order' AND l.source_id = p_order_id
          AND l.event_type = 'ORDER_OUT'
          AND l.inbound_scan_id IS NOT NULL
          AND NOT (SELECT started FROM scan_started)
    ),
    -- (B) 스캔 후 — 남은 필요량을 현재 가용 박스에서 선입선출로 계산한다.
    needs AS (
        SELECT
            i.product_id,
            SUM(i.quantity) AS ordered,
            COALESCE((
                SELECT SUM(-l.qty_delta)
                FROM public.stock_ledger l
                WHERE l.source_type = 'order' AND l.source_id = p_order_id
                  AND l.event_type = 'OUTBOUND_ASSIGN'
                  AND l.product_id = i.product_id
            ), 0) AS assigned
        FROM public.order_items i
        JOIN authorized a ON a.id = i.order_id
        WHERE (SELECT started FROM scan_started)
        GROUP BY i.product_id
    ),
    running AS (
        SELECT
            s.id AS box_id,
            s.product_id,
            s.trace_no,
            s.weight,
            s.remaining_weight,
            s.created_at,
            s.best_before,
            n.ordered - n.assigned AS needed,
            -- 이 박스 앞까지의 누적 — 필요량을 채우고 남는 박스는 목록에서 뺀다.
            SUM(s.remaining_weight) OVER (
                PARTITION BY s.product_id ORDER BY s.created_at, s.id
                ROWS UNBOUNDED PRECEDING
            ) - s.remaining_weight AS before_this
        FROM public.inbound_scans s
        JOIN needs n ON n.product_id = s.product_id
        JOIN authorized a ON a.wholesaler_id = s.wholesaler_id
        WHERE s.status = 'NORMAL'
          AND s.remaining_weight > 0
          AND n.ordered - n.assigned > 0
    ),
    from_remaining AS (
        SELECT
            r.product_id,
            p.name,
            p.unit,
            r.box_id,
            r.trace_no,
            LEAST(r.remaining_weight, r.needed - r.before_this) AS suggested_qty,
            r.weight,
            m.grade,
            m.slaughter_date,
            r.created_at,
            false,
            r.best_before,
            (r.best_before - CURRENT_DATE)::INTEGER
        FROM running r
        JOIN public.products p ON p.id = r.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = r.trace_no
        WHERE r.before_this < r.needed
    ),
    -- (C) 이미 찍은 박스 — 목록에 남겨 표시한다 (설계 결정 2번).
    already AS (
        SELECT
            l.product_id,
            p.name,
            p.unit,
            s.id,
            s.trace_no,
            -l.qty_delta,
            s.weight,
            m.grade,
            m.slaughter_date,
            s.created_at,
            true,
            s.best_before,
            (s.best_before - CURRENT_DATE)::INTEGER
        FROM public.stock_ledger l
        JOIN authorized a ON a.id = l.source_id
        JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
        JOIN public.products p ON p.id = l.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
        WHERE l.source_type = 'order' AND l.source_id = p_order_id
          AND l.event_type = 'OUTBOUND_ASSIGN'
    )
    SELECT * FROM from_auto
    UNION ALL
    SELECT * FROM from_remaining
    UNION ALL
    SELECT * FROM already
    -- 이미 찍은 건 아래로, 나머지는 오래된 순(선입선출).
    ORDER BY 11, 10;
$$;
