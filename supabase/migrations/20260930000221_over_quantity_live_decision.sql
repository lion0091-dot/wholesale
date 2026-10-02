-- ====================================================================
-- 발주 수량 초과 입고 — 사전 설정(REJECT/HOLD) 대신 그 자리에서 사람에게 물어본다.
-- 대표 결정(2026-10-02): "대표가 받아 하면 받아야지" — 현장 직원도 그 자리에서 바로 답할 수 있다.
-- (설정 화면에서 매번 정책을 바꾸고 다시 찍는 번거로움 제거. 전표에 없는 물건(UNLISTED)은
--  이 결정과 무관 — receiving_policies.unlisted_item_policy 그대로 유지.)
--
-- judge_scan_purchase_order: OVER 판정이면 더 이상 자동으로 거절/보류하지 않고
-- po_state='OVER_PENDING'만 남기고 돌아온다. 새 함수 resolve_scan_over_quantity()가
-- 사람의 받기/거절 응답을 받아 마저 처리한다(받기=기존 OVER_HELD 로직, 거절=기존 REJECTED 로직).
-- ====================================================================

CREATE OR REPLACE FUNCTION public.judge_scan_purchase_order(p_scan_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid      UUID;
    v_scan     public.inbound_scans%ROWTYPE;
    v_policy   public.receiving_policies%ROWTYPE;
    v_mode     TEXT := 'PERCENT';
    v_value    NUMERIC := 0;
    v_unlisted TEXT := 'REJECT';
    v_lines    INTEGER;
    v_ordered  NUMERIC;
    v_received NUMERIC;
    v_tol      NUMERIC;
    v_reason   TEXT;
    v_detail   JSONB;
    v_line     RECORD;
    v_left     NUMERIC;
    v_take     NUMERIC;
    v_last     UUID;
    v_pos      UUID[];
    v_po       UUID;
    v_closed   BOOLEAN := false;
    v_last_closed_po UUID;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();
    IF v_wid IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wid
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    -- 거래처가 없거나 상품이 아직 안 정해졌거나 정상 입고가 아니면 판정하지 않는다.
    IF v_scan.supplier_id IS NULL OR v_scan.product_id IS NULL OR v_scan.status <> 'NORMAL' THEN
        RETURN jsonb_build_object('result', 'SKIPPED');
    END IF;

    -- 멱등: 이미 판정된 박스는 결과만 돌려줄 뿐 다시 세지 않는다(OVER_PENDING도 포함 — 대기 중에
    -- 다시 호출돼도 같은 질문을 또 만들지 않는다).
    IF v_scan.po_state IS NOT NULL THEN
        RETURN jsonb_build_object('result', v_scan.po_state) || public.purchase_order_scan_progress(p_scan_id)
            || COALESCE(v_scan.po_detail, '{}'::jsonb);
    END IF;

    PERFORM 1 FROM public.products WHERE id = v_scan.product_id FOR UPDATE;

    SELECT * INTO v_policy FROM public.receiving_policies WHERE wholesaler_id = v_wid;
    IF v_policy.wholesaler_id IS NOT NULL THEN
        v_mode := v_policy.over_tolerance_mode;
        v_value := v_policy.over_tolerance_value;
        v_unlisted := v_policy.unlisted_item_policy;
    END IF;

    -- 후보 = 그 거래처의 열린 발주서 중 이 상품 줄 전체를 하나로 묶은 것(발주일 → 작성 시각 → 줄 번호 순).
    WITH cand AS (
        SELECT l.id AS line_id, l.quantity,
               COALESCE((
                   SELECT sum(x.weight)
                   FROM public.purchase_order_line_scans x
                   JOIN public.inbound_scans s ON s.id = x.scan_id
                   WHERE x.line_id = l.id AND s.status <> 'VOIDED'
               ), 0) AS received
        FROM public.purchase_order_lines l
        JOIN public.purchase_orders po ON po.id = l.purchase_order_id
        WHERE po.wholesaler_id = v_wid
          AND po.supplier_id = v_scan.supplier_id
          AND po.status = 'OPEN'
          AND l.product_id = v_scan.product_id
    )
    SELECT count(*), COALESCE(sum(quantity), 0), COALESCE(sum(received), 0)
    INTO v_lines, v_ordered, v_received
    FROM cand;

    v_tol := CASE WHEN v_mode = 'PERCENT' THEN v_ordered * v_value / 100 ELSE v_value END;

    IF v_lines = 0 THEN
        -- 다 받아서 자동 마감된 발주서에 있는 품목이면 "없는 물건"이 아니라 "이미 다 받은 물건이 더 온 것"이다(초과).
        -- 사람이 닫은 발주서는 해당하지 않는다 — 다 받았다는 뜻이 아니므로 없는 물건 기준을 따른다.
        -- 이때 보여줄 발주량·받은 양은 "가장 최근에 자동 마감된 그 발주서 한 건" 기준으로만 계산한다
        -- (여러 건을 합치면 서로 무관한 발주 건이 하나로 뒤섞여 보인다).
        SELECT po.id INTO v_last_closed_po
        FROM public.purchase_orders po
        JOIN public.purchase_order_lines l ON l.purchase_order_id = po.id
        WHERE po.wholesaler_id = v_wid
          AND po.supplier_id = v_scan.supplier_id
          AND po.status = 'CLOSED'
          AND po.auto_closed_at IS NOT NULL
          AND l.product_id = v_scan.product_id
        ORDER BY po.auto_closed_at DESC
        LIMIT 1;

        IF v_last_closed_po IS NOT NULL THEN
            WITH closed_cand AS (
                SELECT l.quantity,
                       COALESCE((
                           SELECT sum(x.weight)
                           FROM public.purchase_order_line_scans x
                           JOIN public.inbound_scans s ON s.id = x.scan_id
                           WHERE x.line_id = l.id AND s.status <> 'VOIDED'
                       ), 0) AS received
                FROM public.purchase_order_lines l
                WHERE l.purchase_order_id = v_last_closed_po
                  AND l.product_id = v_scan.product_id
            )
            SELECT COALESCE(sum(quantity), 0), COALESCE(sum(received), 0)
            INTO v_ordered, v_received
            FROM closed_cand;

            v_reason := 'OVER';
            v_tol := CASE WHEN v_mode = 'PERCENT' THEN v_ordered * v_value / 100 ELSE v_value END;
        ELSIF v_unlisted = 'HOLD' THEN
            UPDATE public.inbound_scans
            SET po_state = 'UNLISTED_HELD', po_detail = NULL
            WHERE id = p_scan_id;
            RETURN jsonb_build_object('result', 'UNLISTED_HELD');
        ELSE
            v_reason := 'UNLISTED';
            v_ordered := 0;
            v_received := 0;
        END IF;
    ELSIF v_received + v_scan.weight > v_ordered + v_tol THEN
        v_reason := 'OVER';
    END IF;

    -- 발주 초과는 더 이상 사전 설정으로 자동 판정하지 않는다 — 그 자리에서 사람에게 물어본다.
    -- resolve_scan_over_quantity()가 받기/거절 응답을 받아 마저 처리한다.
    IF v_reason = 'OVER' THEN
        v_detail := jsonb_build_object(
            'reason', 'OVER',
            'ordered', v_ordered, 'received', v_received, 'tolerance', v_tol,
            'tolerance_mode', v_mode, 'tolerance_value', v_value, 'weight', v_scan.weight
        );

        UPDATE public.inbound_scans
        SET po_state = 'OVER_PENDING', po_detail = v_detail
        WHERE id = p_scan_id;

        RETURN jsonb_build_object('result', 'OVER_PENDING') || v_detail;
    END IF;

    -- 여기부터는 UNLISTED 사유만 남는다(REJECT만 — HOLD는 위에서 이미 UNLISTED_HELD로 돌아갔다).
    IF v_reason IS NOT NULL THEN
        v_detail := jsonb_build_object(
            'ordered', v_ordered, 'received', v_received, 'tolerance', v_tol,
            'tolerance_mode', v_mode, 'tolerance_value', v_value, 'weight', v_scan.weight
        );

        INSERT INTO public.inbound_rejections (wholesaler_id, supplier_id, scan_id, trace_no, product_id, weight, reason, detail)
        VALUES (v_wid, v_scan.supplier_id, p_scan_id, v_scan.trace_no, v_scan.product_id, v_scan.weight, v_reason, v_detail);

        PERFORM public.void_inbound_scan(p_scan_id, '발주서에 없는 품목이라 받지 않음');

        RETURN jsonb_build_object(
            'result', 'REJECTED', 'reason', v_reason,
            'ordered', v_ordered, 'received', v_received, 'tolerance', v_tol
        );
    END IF;

    -- 받는다. 박스 무게를 자리가 남은 줄부터 차례로 채운다. 허용 오차 안의 초과분은 마지막에 채운 줄(없으면 맨 뒤 줄)에 얹는다.
    v_left := v_scan.weight;

    FOR v_line IN
        SELECT l.id AS line_id, l.quantity - COALESCE((
                   SELECT sum(x.weight)
                   FROM public.purchase_order_line_scans x
                   JOIN public.inbound_scans s ON s.id = x.scan_id
                   WHERE x.line_id = l.id AND s.status <> 'VOIDED'
               ), 0) AS room
        FROM public.purchase_order_lines l
        JOIN public.purchase_orders po ON po.id = l.purchase_order_id
        WHERE po.wholesaler_id = v_wid
          AND po.supplier_id = v_scan.supplier_id
          AND po.status = 'OPEN'
          AND l.product_id = v_scan.product_id
        ORDER BY po.ordered_on, po.created_at, l.line_no, l.id
    LOOP
        EXIT WHEN v_left <= 0;
        CONTINUE WHEN v_line.room <= 0;

        v_take := LEAST(v_line.room, v_left);

        INSERT INTO public.purchase_order_line_scans (scan_id, line_id, wholesaler_id, weight, linked_by)
        VALUES (p_scan_id, v_line.line_id, v_wid, v_take, auth.uid());

        v_left := v_left - v_take;
        v_last := v_line.line_id;
    END LOOP;

    -- 허용 오차 안의 초과분은 남은 자리가 없어도 마지막에 채운 줄(없으면 맨 뒤 줄)에 얹는다.
    IF v_left > 0 THEN
        IF v_last IS NULL THEN
            SELECT l.id INTO v_last
            FROM public.purchase_order_lines l
            JOIN public.purchase_orders po ON po.id = l.purchase_order_id
            WHERE po.wholesaler_id = v_wid
              AND po.supplier_id = v_scan.supplier_id
              AND po.status = 'OPEN'
              AND l.product_id = v_scan.product_id
            ORDER BY po.ordered_on DESC, po.created_at DESC, l.line_no DESC, l.id DESC
            LIMIT 1;

            INSERT INTO public.purchase_order_line_scans (scan_id, line_id, wholesaler_id, weight, linked_by)
            VALUES (p_scan_id, v_last, v_wid, v_left, auth.uid());
        ELSE
            UPDATE public.purchase_order_line_scans
            SET weight = weight + v_left
            WHERE scan_id = p_scan_id AND line_id = v_last;
        END IF;
    END IF;

    UPDATE public.inbound_scans
    SET po_state = 'ASSIGNED', po_detail = NULL
    WHERE id = p_scan_id;

    SELECT array_agg(DISTINCT l.purchase_order_id) INTO v_pos
    FROM public.purchase_order_line_scans x
    JOIN public.purchase_order_lines l ON l.id = x.line_id
    WHERE x.scan_id = p_scan_id;

    FOREACH v_po IN ARRAY COALESCE(v_pos, ARRAY[]::UUID[]) LOOP
        IF public.refresh_purchase_order_completion(v_po) THEN
            v_closed := true;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('result', 'ASSIGNED', 'order_closed', v_closed) || public.purchase_order_scan_progress(p_scan_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.judge_scan_purchase_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.judge_scan_purchase_order(UUID) TO authenticated, service_role;

-- ====================================================================
-- 초과 입고 박스를 "받을까요/거절할까요?" 질문에 대한 답으로 마저 처리한다.
-- 권한은 judge_scan_purchase_order와 같은 화면(입고 스캔)의 호출자 기준 — 현장 직원도 포함한다
-- (대표 결정: 초과 박스를 받을지는 owner/manager 승인 없이 그 자리에서 누구나 답할 수 있다).
-- ====================================================================
CREATE OR REPLACE FUNCTION public.resolve_scan_over_quantity(p_scan_id uuid, p_accept boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid      UUID;
    v_scan     public.inbound_scans%ROWTYPE;
    v_detail   JSONB;
    v_left     NUMERIC;
    v_take     NUMERIC;
    v_last     UUID;
    v_line     RECORD;
    v_pos      UUID[];
    v_po       UUID;
    v_closed   BOOLEAN := false;
    v_ordered  NUMERIC;
    v_received NUMERIC;
    v_tol      NUMERIC;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();
    IF v_wid IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wid
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.po_state IS DISTINCT FROM 'OVER_PENDING' THEN
        RAISE EXCEPTION 'NOT_PENDING';
    END IF;

    PERFORM 1 FROM public.products WHERE id = v_scan.product_id FOR UPDATE;

    v_detail := COALESCE(v_scan.po_detail, '{}'::jsonb);
    v_ordered := COALESCE((v_detail->>'ordered')::numeric, 0);
    v_received := COALESCE((v_detail->>'received')::numeric, 0);
    v_tol := COALESCE((v_detail->>'tolerance')::numeric, 0);

    IF NOT p_accept THEN
        INSERT INTO public.inbound_rejections (wholesaler_id, supplier_id, scan_id, trace_no, product_id, weight, reason, detail)
        VALUES (v_wid, v_scan.supplier_id, p_scan_id, v_scan.trace_no, v_scan.product_id, v_scan.weight, 'OVER', v_detail);

        UPDATE public.inbound_scans SET po_state = NULL, po_detail = NULL WHERE id = p_scan_id;

        PERFORM public.void_inbound_scan(p_scan_id, '발주 수량 초과로 받지 않음(현장 확인)');

        RETURN jsonb_build_object(
            'result', 'REJECTED', 'reason', 'OVER',
            'ordered', v_ordered, 'received', v_received, 'tolerance', v_tol
        );
    END IF;

    -- 받는다: judge_scan_purchase_order의 "받는다" 로직과 동일 — 자리가 남은 줄부터 채우고
    -- 넘친 무게는 어느 줄에도 안 붙인다(허용 오차 글루온 로직은 여기선 쓰지 않는다 — 이미 초과를
    -- 알고 받기로 한 것이므로 남는 건 전부 excess로 남긴다).
    v_left := v_scan.weight;

    FOR v_line IN
        SELECT l.id AS line_id, l.quantity - COALESCE((
                   SELECT sum(x.weight)
                   FROM public.purchase_order_line_scans x
                   JOIN public.inbound_scans s ON s.id = x.scan_id
                   WHERE x.line_id = l.id AND s.status <> 'VOIDED'
               ), 0) AS room
        FROM public.purchase_order_lines l
        JOIN public.purchase_orders po ON po.id = l.purchase_order_id
        WHERE po.wholesaler_id = v_wid
          AND po.supplier_id = v_scan.supplier_id
          AND po.status = 'OPEN'
          AND l.product_id = v_scan.product_id
        ORDER BY po.ordered_on, po.created_at, l.line_no, l.id
    LOOP
        EXIT WHEN v_left <= 0;
        CONTINUE WHEN v_line.room <= 0;

        v_take := LEAST(v_line.room, v_left);

        INSERT INTO public.purchase_order_line_scans (scan_id, line_id, wholesaler_id, weight, linked_by)
        VALUES (p_scan_id, v_line.line_id, v_wid, v_take, auth.uid());

        v_left := v_left - v_take;
        v_last := v_line.line_id;
    END LOOP;

    v_detail := jsonb_build_object(
        'ordered', v_ordered, 'received', v_received + (v_scan.weight - v_left),
        'remaining', 0, 'tolerance', v_tol, 'excess', v_left
    );

    UPDATE public.inbound_scans
    SET po_state = 'OVER_HELD', po_detail = v_detail
    WHERE id = p_scan_id;

    SELECT array_agg(DISTINCT l.purchase_order_id) INTO v_pos
    FROM public.purchase_order_line_scans x
    JOIN public.purchase_order_lines l ON l.id = x.line_id
    WHERE x.scan_id = p_scan_id;

    FOREACH v_po IN ARRAY COALESCE(v_pos, ARRAY[]::UUID[]) LOOP
        IF public.refresh_purchase_order_completion(v_po) THEN
            v_closed := true;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('result', 'OVER_HELD', 'order_closed', v_closed) || v_detail;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_scan_over_quantity(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_scan_over_quantity(UUID, BOOLEAN) TO authenticated;

ALTER TABLE public.inbound_scans
  DROP CONSTRAINT IF EXISTS inbound_scans_po_state_check;
ALTER TABLE public.inbound_scans
  ADD CONSTRAINT inbound_scans_po_state_check
  CHECK (po_state IS NULL OR (po_state = ANY (ARRAY['ASSIGNED'::text, 'UNLISTED_HELD'::text, 'OVER_HELD'::text, 'OVER_PENDING'::text])));

-- ====================================================================
-- resolve_inbound_mapping_to_order: "받을까요?" 대기 중인 박스를 그 틈에 특정 주문으로
-- 바로 출고해 버리면, 나중에 사무실이 "거절"을 눌러도 이미 출고돼(void_inbound_scan이
-- PARTIALLY_SHIPPED로 막음) 되돌릴 수 없는 상태가 된다. REJECTED와 같이 출고를 건너뛴다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping_to_order(p_scan_id uuid, p_product_id uuid, p_order_id uuid, p_remember boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_resolve  JSONB;
    v_outbound JSONB;
    v_scan     public.inbound_scans%ROWTYPE;
BEGIN
    v_resolve := public.resolve_inbound_mapping(p_scan_id, p_product_id, p_remember);

    IF v_resolve ->> 'status' = 'REJECTED' OR v_resolve -> 'po' ->> 'result' = 'OVER_PENDING' THEN
        RETURN jsonb_build_object('resolve', v_resolve, 'outbound', NULL);
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    -- p_weight를 생략(NULL)하면 record_outbound_scan이 "박스 잔량과 주문에 필요한
    -- 양 중 작은 쪽"을 알아서 가져간다 — 방금 들어온 박스가 주문보다 커도 문제없다.
    v_outbound := public.record_outbound_scan(p_order_id, v_scan.trace_no, NULL, p_scan_id);

    RETURN jsonb_build_object('resolve', v_resolve, 'outbound', v_outbound);
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_inbound_mapping_to_order(UUID, UUID, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_inbound_mapping_to_order(UUID, UUID, UUID, BOOLEAN) TO authenticated;
