-- 통단 재감사(2026-09-27, 145 배포 직후)에서 발견 — 145 자신이 만든 결함 2건.
--
-- 1) judge_scan_purchase_order의 멱등(이미 판정된 박스 재조회) 분기가
--    jsonb_build_object(...) || po_detail || purchase_order_scan_progress(...) 순으로 합쳐서,
--    뒤에 온 purchase_order_scan_progress가 po_detail의 ordered/received/remaining을 덮어썼다.
--    이미 CLOSED된 발주서 초과분(OVER_HELD, v_lines=0 분기)은 이 스캔이 purchase_order_line_scans에
--    행이 없어서 progress가 0/0/0을 돌려주고, 방금 저장한 실제 수치가 재조회 시 다시 0/0으로 보였다.
--    합치는 순서를 뒤집어 po_detail이 마지막에 덮도록 한다(ASSIGNED는 po_detail이 NULL이라
--    영향 없음 — progress 계산 그대로 유지).
--
-- 2) create_retroactive_purchase_order("발주서 추가 생성")가 po_state를 ASSIGNED로 바꾸면서
--    po_detail은 그대로 둬서, OVER_HELD였던 박스를 사후 등록하면 ASSIGNED인데 po_detail엔 옛
--    OVER_HELD 수치(특히 excess)가 남았다. 145가 세운 불변식(ASSIGNED·REJECTED는 po_detail을
--    비워 둔다)을 145 배포 직후 143의 형제 함수가 깨고 있었다 — po_state를 ASSIGNED로 바꿀 때
--    po_detail도 같이 비운다.
--
-- 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로 패치했다.

CREATE OR REPLACE FUNCTION public.judge_scan_purchase_order(p_scan_id UUID)
RETURNS JSONB
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
    v_over     TEXT := 'REJECT';
    v_over_held BOOLEAN := false;
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

    -- 멱등: 이미 판정된 박스는 결과만 돌려줄 뿐 다시 세지 않는다.
    -- po_detail이 있으면(HELD 계열) 그 저장값이 최종값 — progress는 ASSIGNED용 계산이라 먼저 합치고 po_detail로 덮는다.
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
        v_over := v_policy.over_item_policy;
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
        -- 이때는 화면에 보여줄 실제 발주량·받은 양을 그 CLOSED 발주서 줄 기준으로 다시 계산한다
        -- (위 cand CTE는 OPEN 줄만 봐서 여기선 항상 0/0이다).
        WITH closed_cand AS (
            SELECT l.quantity,
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
              AND po.status = 'CLOSED'
              AND po.auto_closed_at IS NOT NULL
              AND l.product_id = v_scan.product_id
        )
        SELECT COALESCE(sum(quantity), 0), COALESCE(sum(received), 0)
        INTO v_ordered, v_received
        FROM closed_cand;

        IF v_ordered > 0 OR v_received > 0 THEN
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

    IF v_reason = 'OVER' AND v_over = 'HOLD' THEN
        v_over_held := true;
        v_reason := NULL;
    END IF;

    IF v_reason IS NOT NULL THEN
        v_detail := jsonb_build_object(
            'ordered', v_ordered, 'received', v_received, 'tolerance', v_tol,
            'tolerance_mode', v_mode, 'tolerance_value', v_value, 'weight', v_scan.weight
        );

        INSERT INTO public.inbound_rejections (wholesaler_id, supplier_id, scan_id, trace_no, product_id, weight, reason, detail)
        VALUES (v_wid, v_scan.supplier_id, p_scan_id, v_scan.trace_no, v_scan.product_id, v_scan.weight, v_reason, v_detail);

        PERFORM public.void_inbound_scan(
            p_scan_id,
            CASE v_reason WHEN 'OVER' THEN '발주 수량 초과로 받지 않음' ELSE '발주서에 없는 품목이라 받지 않음' END
        );

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

    -- 초과를 받아 두는 경우(HOLD)는 남은 자리만 채우고, 넘친 무게는 어느 줄에도 붙이지 않는다.
    IF v_left > 0 AND NOT v_over_held THEN
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

    IF v_over_held THEN
        v_detail := jsonb_build_object(
            'ordered', v_ordered, 'received', v_received + (v_scan.weight - v_left),
            'remaining', 0, 'tolerance', v_tol, 'excess', v_left
        );

        UPDATE public.inbound_scans
        SET po_state = 'OVER_HELD', po_detail = v_detail
        WHERE id = p_scan_id;
    ELSE
        UPDATE public.inbound_scans
        SET po_state = 'ASSIGNED', po_detail = NULL
        WHERE id = p_scan_id;
    END IF;

    SELECT array_agg(DISTINCT l.purchase_order_id) INTO v_pos
    FROM public.purchase_order_line_scans x
    JOIN public.purchase_order_lines l ON l.id = x.line_id
    WHERE x.scan_id = p_scan_id;

    FOREACH v_po IN ARRAY COALESCE(v_pos, ARRAY[]::UUID[]) LOOP
        IF public.refresh_purchase_order_completion(v_po) THEN
            v_closed := true;
        END IF;
    END LOOP;

    IF v_over_held THEN
        RETURN jsonb_build_object('result', 'OVER_HELD', 'order_closed', v_closed) || v_detail;
    END IF;

    RETURN jsonb_build_object('result', 'ASSIGNED', 'order_closed', v_closed) || public.purchase_order_scan_progress(p_scan_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.judge_scan_purchase_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.judge_scan_purchase_order(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------------
-- create_retroactive_purchase_order: po_state를 ASSIGNED로 바꿀 때 po_detail도 같이 비운다.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_retroactive_purchase_order(p_scan_id UUID, p_supplier_id UUID, p_ordered_on DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid       UUID;
    v_scan      public.inbound_scans%ROWTYPE;
    v_product   public.products%ROWTYPE;
    v_supplier  RECORD;
    v_amount    NUMERIC;
    v_order_id  UUID;
    v_line_id   UUID;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();

    IF v_wid IS NULL OR NOT public.can_manage_wholesaler(v_wid) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id AND wholesaler_id = v_wid FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status <> 'NORMAL' OR v_scan.product_id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_READY';
    END IF;

    SELECT id, name INTO v_supplier FROM public.suppliers WHERE id = p_supplier_id AND wholesaler_id = v_wid;

    IF v_supplier.id IS NULL THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
    END IF;

    v_amount := public.scan_unassigned_weight(p_scan_id);

    IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'NOTHING_TO_ASSIGN';
    END IF;

    SELECT * INTO v_product FROM public.products WHERE id = v_scan.product_id AND wholesaler_id = v_wid;

    IF v_product.id IS NULL THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    INSERT INTO public.purchase_orders (wholesaler_id, supplier_id, supplier_name, ordered_on, status, note)
    VALUES (
        v_wid, v_supplier.id, v_supplier.name, COALESCE(p_ordered_on, current_date), 'OPEN',
        '실물 입고 뒤 "발주서 추가 생성"으로 만들어짐'
    )
    RETURNING id INTO v_order_id;

    INSERT INTO public.purchase_order_lines (
        purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, unit, product_id
    ) VALUES (
        v_order_id, v_wid, 1, v_product.category, v_product.subcategory, v_product.grade, v_product.origin,
        v_product.breed, v_amount, COALESCE(v_product.unit, 'kg'), v_product.id
    )
    RETURNING id INTO v_line_id;

    INSERT INTO public.purchase_order_line_scans (scan_id, line_id, wholesaler_id, weight, linked_by)
    VALUES (p_scan_id, v_line_id, v_wid, v_amount, auth.uid());

    UPDATE public.inbound_scans SET po_state = 'ASSIGNED', po_detail = NULL WHERE id = p_scan_id;

    PERFORM public.refresh_purchase_order_completion(v_order_id);

    RETURN jsonb_build_object('order_id', v_order_id, 'line_id', v_line_id, 'amount', v_amount);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_retroactive_purchase_order(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
