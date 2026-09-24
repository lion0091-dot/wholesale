-- ====================================================================
-- 주문 확정 재고 차감 — 동시성 레이스 차단 + 091~094 회귀 복원 (2026-09-24 점검 1)
--
-- (A) 회귀 복원
--   apply_order_shipment / reverse_order_shipment는 079에서 "상품별 순 출고량으로
--   모자란 만큼만 차감"(확보 대기 주문 이중 차감 방지)과 068의 그램 정밀도
--   NUMERIC(10,3)을 갖게 됐다. 그런데 핫딜 한도 마이그레이션 091·092·094가 054
--   본문을 기반으로 다시 정의하면서 둘 다 사라졌다(로컬 DB 실제 함수로 확인).
--     - 확보 대기 주문에 입고 즉시 배정으로 박스를 붙인 뒤 확정하면 주문 수량
--       전체가 한 번 더 빠졌다.
--     - 박스 잔량이 8.205kg처럼 g 단위면 차감량이 8.21로 반올림돼 잔량이 음수가
--       되고 remaining_weight >= 0 제약에 걸려 확정 자체가 실패했다.
--   여기서 079 본문으로 되돌린다(094가 뺀 핫딜 블록은 079에도 없으니 그대로).
--
-- (B) 동시 확정 레이스
--   서로 다른 두 주문을 같은 상품으로 동시에 확정하면 가용량(SUM(qty_delta))을
--   잠금 없이 읽어 둘 다 통과했다. 박스는 FOR UPDATE라 초과 차감이 안 되지만
--   모자란 분량이 "이력 미추적 재고분" 행으로 그대로 들어가고, 기초재고만 있는
--   상품은 둘 다 통째로 빠졌다. 최후 방어선이어야 할 products.stock_quantity >= 0
--   CHECK도 못 잡았다 — recalc_product_stock()이 합계를 변수에 먼저 읽고 UPDATE
--   하기 때문에, 두 번째 트랜잭션은 첫 번째가 커밋되기 전 스냅샷의 합계(양수)를
--   써서 CHECK를 통과했고 "표시 재고는 양수, 원장 합계는 음수"로 어긋났다.
--
--   잠긴 설계 결정(이번):
--     1. 잠금 순서는 전 함수 공통으로 "박스(inbound_scans) → 상품(products)"을
--        유지한다. 상품 행을 먼저 잠그는 방식은 박스를 먼저 잠그는 출고 스캔·
--        취소 원복·세트 조립과 순서가 엇갈려 교착이 난다.
--     2. 그래서 상품 행 잠금은 맨 마지막 단계에서 한다 —
--        (a) recalc_product_stock()이 상품 행을 FOR UPDATE로 잠근 **뒤** 합계를
--            읽는다. READ COMMITTED에서는 문장마다 새 스냅샷이므로, 잠금 대기가
--            끝난 다음 문장의 SUM은 앞 트랜잭션이 커밋한 행을 본다. 이제 CHECK가
--            제 역할을 한다(음수면 그 트랜잭션 전체가 되돌아간다).
--        (b) apply_order_shipment는 박스 차감 뒤 "박스 없는 분량"을 넣기 전에
--            상품 행을 잠그고 가용량을 다시 확인해, CHECK 위반 대신 사람이 읽을 수
--            있는 INSUFFICIENT_STOCK 메시지로 막는다.
--        (c) adjust_product_stock은 박스를 안 잠그므로 상품 행을 처음부터 잠근다
--            (P만 잡고 다른 걸 기다리지 않아 교착 없음).
--     3. 격리수준은 올리지 않는다. 직렬화 실패 재시도 로직을 앱 전체에 넣는 것보다
--        행 잠금 하나가 단순하고, 재고를 줄이는 경로는 전부 recalc를 거친다.
-- ====================================================================


-- --------------------------------------------------------------------
-- 1. recalc_product_stock — 상품 행을 잠근 뒤 합계를 읽는다 (본문은 090과 동일)
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalc_product_stock(p_product_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_new_stock NUMERIC;
BEGIN
    -- 먼저 잠근다. 동시 차감이 있으면 여기서 기다렸다가, 다음 문장의 SUM이
    -- 상대가 커밋한 원장 행까지 본 값이 된다(설계 결정 2-a).
    PERFORM 1 FROM public.products WHERE id = p_product_id FOR UPDATE;

    SELECT COALESCE(SUM(qty_delta), 0) INTO v_new_stock
    FROM public.stock_ledger
    WHERE product_id = p_product_id;

    UPDATE public.products
    SET stock_quantity = v_new_stock,
        order_stopped = CASE
            WHEN v_new_stock <= 0 AND NOT order_stopped THEN true
            ELSE order_stopped
        END,
        order_stopped_reason = CASE
            WHEN v_new_stock <= 0 AND NOT order_stopped THEN 'out_of_stock'
            ELSE order_stopped_reason
        END,
        order_stopped_at = CASE
            WHEN v_new_stock <= 0 AND NOT order_stopped THEN now()
            ELSE order_stopped_at
        END,
        updated_at = now()
    WHERE id = p_product_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recalc_product_stock(UUID) FROM PUBLIC;


-- --------------------------------------------------------------------
-- 2. apply_order_shipment — 079 본문 복원 + 박스 차감 후 잠금 아래 재확인
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

    -- "ORDER_OUT이 하나라도 있으면 통째로 건너뛴다" 가드는 쓰지 않는다(079).
    -- 출고 스캔이 ORDER_OUT 없이 OUTBOUND_ASSIGN만 남기는 경우(확보 대기 주문)를
    -- 그 가드가 못 잡아 이중 차감이 났다. 상품별 순량으로 판정하면 재확정 시
    -- 중복 차감 방지까지 함께 커버된다.
    FOR v_item IN
        SELECT product_id, SUM(quantity) AS quantity, MAX(product_name) AS product_name
        FROM public.order_items
        WHERE order_id = p_order_id
        GROUP BY product_id
        -- 상품 순서를 고정해 동시 확정 간 잠금 순서를 일치시킨다(교착 방지).
        ORDER BY product_id
    LOOP
        -- 이 주문·이 상품으로 이미 빠져나간 순량.
        SELECT COALESCE(-SUM(qty_delta), 0) INTO v_already
        FROM public.stock_ledger
        WHERE source_type = 'order'
          AND source_id = p_order_id
          AND product_id = v_item.product_id
          AND event_type IN ('ORDER_OUT', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN', 'ORDER_RESTORE');

        v_remaining := v_item.quantity - v_already;

        IF v_remaining <= 0 THEN
            CONTINUE;
        END IF;

        PERFORM public.ensure_opening_balance(v_item.product_id);

        -- 1차 확인(빠른 실패용 — 잠금 전이라 동시 확정은 아래 2차 확인이 막는다).
        SELECT COALESCE(SUM(qty_delta), 0) INTO v_available
        FROM public.stock_ledger WHERE product_id = v_item.product_id;

        IF v_available < v_remaining THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
                v_item.product_name, v_available, v_remaining;
        END IF;

        -- (a) 이력 추적되는 박스에서 선입선출로 뺀다. FOR UPDATE라 동시 확정이
        --     같은 박스를 두 번 빼지는 못한다(잠금 뒤 갱신된 잔량을 다시 읽는다).
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
        --     여기가 동시 확정 레이스의 구멍이었다 — 상품 행을 잠근 상태에서
        --     (박스 → 상품 순서, 설계 결정 2-b) 가용량을 새 스냅샷으로 다시 본다.
        --     내 박스 차감분은 이미 원장에 있으므로 이 합계는 "지금 남은 전체"다.
        IF v_remaining > 0 THEN
            PERFORM 1 FROM public.products WHERE id = v_item.product_id FOR UPDATE;

            SELECT COALESCE(SUM(qty_delta), 0) INTO v_available
            FROM public.stock_ledger WHERE product_id = v_item.product_id;

            IF v_available < v_remaining THEN
                RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
                    v_item.product_name, v_available, v_remaining;
            END IF;

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
-- 3. reverse_order_shipment — 079 본문 복원 (배정만 된 확보 대기 주문도 원복)
-- --------------------------------------------------------------------
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
        ORDER BY product_id, inbound_scan_id
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
-- 4. adjust_product_stock — 상품 행을 처음부터 잠근다 (본문은 097과 동일)
--    박스를 안 잠그는 함수라 P만 잡고 기다릴 게 없어 교착이 없다(설계 결정 2-c).
-- --------------------------------------------------------------------
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
    v_product       public.products%ROWTYPE;
    v_current       NUMERIC(10, 3);
    v_delta         NUMERIC(10, 3);
    v_event_type    TEXT;
    v_reason_label  TEXT;
BEGIN
    SELECT * INTO v_product FROM public.products WHERE id = p_product_id FOR UPDATE;

    IF v_product.id IS NULL OR NOT public.can_access_wholesaler(v_product.wholesaler_id) THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    IF NOT public.can_manage_wholesaler(v_product.wholesaler_id) THEN
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

    PERFORM public.ensure_opening_balance(p_product_id);

    SELECT COALESCE(SUM(qty_delta), 0) INTO v_current
    FROM public.stock_ledger WHERE product_id = p_product_id;

    v_delta := p_new_quantity - v_current;

    IF v_delta = 0 THEN
        RETURN jsonb_build_object('changed', false, 'stock_quantity', v_current);
    END IF;

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


-- --------------------------------------------------------------------
-- 5. record_outbound_scan — 확정 때 통째로 자동 배정된 박스(잔량 0)도 찍을 수 있어야 한다
--
-- 확정 시 선입선출 자동 배정(ORDER_OUT)이 박스 A를 전부 가져가면 A의 잔량은 0이다.
-- 그런데 출고 스캔은 "잔량 > 0"인 박스만 찾아서, 피킹 목록이 권한 바로 그 박스 A를
-- 작업자가 찍으면 BOX_NOT_AVAILABLE로 거부했다. 자동 배정을 되돌리는 단계
-- (OUTBOUND_UNASSIGN)는 박스를 찾은 **뒤**에 있어서 순서가 뒤집혀 있었다.
-- 지금까지 안 드러난 이유: 091~094 회귀로 차감량이 소수 2자리로 반올림돼
-- (8.204 → 8.20) 박스에 0.004kg가 남아 우연히 통과했고, 세트 박스(1세트 단위)는
-- 실제로 막혀 있었다(scripts/db-test-product-bundles.sql N13이 그 증거).
--
-- 수정: 박스 조회 조건을 "잔량 > 0 **또는** 이 주문의 ORDER_OUT이 붙은 박스"로
-- 넓힌다. 그 뒤 기존 로직대로 그 상품의 자동 배정을 되돌리면(잔량 복원) 박스를
-- 다시 읽어 실제 잔량으로 배정한다. 다른 주문에 배정돼 잔량 0인 박스는 여전히
-- 제외된다. 본문은 20260930000098과 동일, 두 조회의 WHERE만 바뀌었다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_outbound_scan(
    p_order_id UUID,
    p_trace_no TEXT,
    p_weight   NUMERIC DEFAULT NULL,
    p_scan_id  UUID    DEFAULT NULL
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

    IF v_order.status NOT IN ('awaiting_stock', 'confirmed', 'shipping') THEN
        RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE:%', v_order.status;
    END IF;

    IF v_order.shipment_finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'ALREADY_FINALIZED';
    END IF;

    v_trace_no := upper(btrim(COALESCE(p_trace_no, '')));

    IF p_scan_id IS NOT NULL THEN
        -- 박스가 지정됐으면 그 박스만 본다(#11). 이력번호는 박스 것을 쓴다.
        SELECT s.* INTO v_box
        FROM public.inbound_scans s
        WHERE s.id = p_scan_id
          AND s.wholesaler_id = v_wholesaler_id
          AND s.status = 'NORMAL'
          AND (
                s.remaining_weight > 0
             OR EXISTS (
                    SELECT 1 FROM public.stock_ledger l
                    WHERE l.inbound_scan_id = s.id
                      AND l.source_type = 'order' AND l.source_id = p_order_id
                      AND l.event_type = 'ORDER_OUT'
                )
          )
        FOR UPDATE;

        IF v_box.id IS NULL THEN
            RAISE EXCEPTION 'BOX_NOT_AVAILABLE';
        END IF;

        v_trace_no := v_box.trace_no;
    ELSE
        IF v_trace_no = '' THEN
            RAISE EXCEPTION 'EMPTY_TRACE_NO';
        END IF;

        -- 잔량이 있는 박스, 또는 이 주문에 자동 배정돼 잔량이 0이 된 박스.
        SELECT s.* INTO v_box
        FROM public.inbound_scans s
        WHERE s.wholesaler_id = v_wholesaler_id
          AND s.trace_no = v_trace_no
          AND s.status = 'NORMAL'
          AND (
                s.remaining_weight > 0
             OR EXISTS (
                    SELECT 1 FROM public.stock_ledger l
                    WHERE l.inbound_scan_id = s.id
                      AND l.source_type = 'order' AND l.source_id = p_order_id
                      AND l.event_type = 'ORDER_OUT'
                )
          )
        ORDER BY s.created_at
        LIMIT 1
        FOR UPDATE;

        IF v_box.id IS NULL THEN
            RAISE EXCEPTION 'BOX_NOT_AVAILABLE';
        END IF;
    END IF;

    -- 기한이 지난 박스는 내보내지 않는다 (설계 결정 2번).
    IF v_box.best_before IS NOT NULL AND v_box.best_before < CURRENT_DATE THEN
        RAISE EXCEPTION 'BOX_EXPIRED:%', to_char(v_box.best_before, 'YYYY-MM-DD');
    END IF;

    -- 이 상품이 이 주문에서 처음 스캔되는 거면, 그 상품의 자동 배정만 되돌린다.
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

        -- 자동 배정을 되돌리면서 이 박스의 잔량이 바뀌었을 수 있다 — 다시 읽는다.
        SELECT * INTO v_box FROM public.inbound_scans WHERE id = v_box.id;
    END IF;

    -- 되돌린 뒤에도 잔량이 없으면(다른 주문에 배정된 박스) 못 찍는다.
    IF v_box.remaining_weight <= 0 THEN
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
        'best_before',  v_box.best_before,
        'days_left',    v_box.best_before - CURRENT_DATE,
        'part_mismatch', public.parts_conflict(v_trace_part, v_product_part),
        'trace_part', v_trace_part,
        'product_part', v_product_part
    );
END;
$$;
