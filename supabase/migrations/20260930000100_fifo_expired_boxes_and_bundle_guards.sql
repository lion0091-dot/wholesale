-- ====================================================================
-- 선입선출 자동배정에서 기한 지난 박스 제외 + 세트 유령 재고·보관 구성품 차단
-- (2026-09-24 점검 2: FIFO 차감 + 세트(BOM) 역추적 무결성)
--
-- (1) 확정 자동배정(apply_order_shipment)에 유통기한 조건이 없었다.
--     출고 스캔은 기한 지난 박스를 거부하고(070, BOX_EXPIRED) 세트 제작도 제외하는데
--     (071 설계 결정 5번), 자동배정만 가장 오래된 박스라는 이유로 기한 지난 박스를
--     1순위로 잡았다. 스캔 없이 운송장 등록으로 바로 배송되는 흐름에서는 그 박스가
--     그대로 거래명세서에 찍힌다.
--     잠긴 결정: 자동배정 대상은 "기한 안 지난 NORMAL 박스"다. 가용량 판단도
--     "쓸 수 있는 박스 잔량 + 박스 없는 재고(원장 합계 − 전체 박스 잔량)"로 한다 —
--     원장 합계로만 보면 기한 지난 박스의 무게가 '이력 미추적 분량'으로 몰래 빠진다.
--     기한 지난 박스는 재고 숫자에는 남는다(폐기는 재고조정으로 사람이 한다).
--
-- (2) 기존 상품을 세트로 지정할 때 "입출고 기록 없음"만 확인하고 수동 재고
--     (stock_quantity)가 0인지는 안 봤다. 상품 등록 폼 기본값이 10이라, 그 상품을
--     세트로 지정하면 첫 제작 때 ensure_opening_balance가 10을 기초재고로 넣어
--     **박스 없는 세트 10개**가 생기고, 주문되면 박스 없이 차감돼 명세서에 이력번호가
--     하나도 안 나온다(세트의 존재 이유가 깨진다). 수동 재고가 0이 아니면 거부한다.
--
-- (3) 세트 제작 시 보관(archived) 처리된 구성품의 박스를 그대로 썼다. 제작 시점에 거부.
--
-- (4) 같은 트랜잭션에서 만든 세트 박스들은 created_at이 같아 선입선출 순서가 임의였다.
--     trace_no(세트는 SET-YYMMDD-NNN)를 보조 정렬로 둬 제작 순서대로 나가게 한다.
--
-- 본문은 각각 20260930000099(apply) / 20260930000071(save·assemble)과 동일하고
-- 위 항목만 바뀌었다. 실제 DB 본문(pg_get_functiondef)과 마이그레이션이 같음을 확인함.
-- ====================================================================


-- --------------------------------------------------------------------
-- 1. apply_order_shipment — 기한 지난 박스 제외 + 가용량 = 쓸 수 있는 박스 + 박스 없는 재고
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_order_shipment(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order        public.orders%ROWTYPE;
    v_item         RECORD;
    v_box          RECORD;
    v_remaining    NUMERIC(10, 3);
    v_take         NUMERIC(10, 3);
    v_available    NUMERIC(10, 3);
    v_already      NUMERIC(10, 3);
    v_ledger       NUMERIC(10, 3);
    v_all_boxes    NUMERIC(10, 3);
    v_usable_boxes NUMERIC(10, 3);
    v_boxless      NUMERIC(10, 3);
BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
    IF v_order.id IS NULL THEN
        RETURN;
    END IF;

    FOR v_item IN
        SELECT product_id, SUM(quantity) AS quantity, MAX(product_name) AS product_name
        FROM public.order_items
        WHERE order_id = p_order_id
        GROUP BY product_id
        ORDER BY product_id
    LOOP
        -- 이 주문·이 상품으로 이미 빠져나간 순량(079).
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

        -- 가용량 = 쓸 수 있는(기한 안 지난) 박스 잔량 + 박스 없는 재고.
        -- 박스 없는 재고 = 원장 합계 − 전체 박스 잔량(기한 지난 박스 포함).
        SELECT COALESCE(SUM(qty_delta), 0) INTO v_ledger
        FROM public.stock_ledger WHERE product_id = v_item.product_id;

        SELECT COALESCE(SUM(remaining_weight), 0),
               COALESCE(SUM(remaining_weight) FILTER (WHERE best_before IS NULL OR best_before >= CURRENT_DATE), 0)
          INTO v_all_boxes, v_usable_boxes
        FROM public.inbound_scans
        WHERE wholesaler_id = v_order.wholesaler_id
          AND product_id = v_item.product_id
          AND status = 'NORMAL'
          AND remaining_weight > 0;

        v_boxless   := GREATEST(v_ledger - v_all_boxes, 0);
        v_available := v_usable_boxes + v_boxless;

        -- 1차 확인(빠른 실패용 — 잠금 전이라 동시 확정은 아래 2차 확인이 막는다).
        IF v_available < v_remaining THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
                v_item.product_name, v_available, v_remaining;
        END IF;

        -- (a) 기한 안 지난 박스에서 선입선출로 뺀다. 같은 시각이면 이력번호(세트번호) 순.
        FOR v_box IN
            SELECT id, remaining_weight
            FROM public.inbound_scans
            WHERE wholesaler_id = v_order.wholesaler_id
              AND product_id = v_item.product_id
              AND status = 'NORMAL'
              AND remaining_weight > 0
              AND (best_before IS NULL OR best_before >= CURRENT_DATE)
            ORDER BY created_at, trace_no
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

        -- (b) 박스로 못 채운 분량은 "박스 없는 재고"에서만 뺀다. 상품 행을 잠근 뒤
        --     (박스 → 상품 순서, 099 설계 결정) 새 스냅샷으로 다시 계산한다.
        --     내 박스 차감분은 원장·잔량 양쪽에 같이 반영돼 있어 박스 없는 재고 값에
        --     영향이 없고, 동시 확정이 먼저 커밋했으면 그만큼 줄어든 값이 보인다.
        IF v_remaining > 0 THEN
            PERFORM 1 FROM public.products WHERE id = v_item.product_id FOR UPDATE;

            SELECT COALESCE(SUM(qty_delta), 0) INTO v_ledger
            FROM public.stock_ledger WHERE product_id = v_item.product_id;

            SELECT COALESCE(SUM(remaining_weight), 0) INTO v_all_boxes
            FROM public.inbound_scans
            WHERE wholesaler_id = v_order.wholesaler_id
              AND product_id = v_item.product_id
              AND status = 'NORMAL'
              AND remaining_weight > 0;

            v_boxless := GREATEST(v_ledger - v_all_boxes, 0);

            IF v_boxless < v_remaining THEN
                RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
                    v_item.product_name, v_boxless, v_remaining;
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
-- 2. save_product_bundle — 기존 상품 세트 지정 시 수동 재고 0 요구 (본문은 071과 동일)
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_product_bundle(
    p_items       JSONB,
    p_bundle_id   UUID    DEFAULT NULL,
    p_product_id  UUID    DEFAULT NULL,
    p_name        TEXT    DEFAULT NULL,
    p_base_price  NUMERIC DEFAULT NULL,
    p_bundle_code TEXT    DEFAULT NULL,
    p_memo        TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_bundle        public.product_bundles%ROWTYPE;
    v_product_id    UUID;
    v_bundle_id     UUID;
    v_code          TEXT;
    v_item          RECORD;
    v_component     public.products%ROWTYPE;
    v_category      TEXT;
    v_origin        TEXT;
    v_created       BOOLEAN := false;
    v_count         INTEGER;
    v_manual_stock  NUMERIC(10, 3);
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'BUNDLE_HAS_NO_ITEMS';
    END IF;

    -- ① 대상 세트/상품 결정 -------------------------------------------------
    IF p_bundle_id IS NOT NULL THEN
        SELECT * INTO v_bundle FROM public.product_bundles WHERE id = p_bundle_id;

        IF v_bundle.id IS NULL OR v_bundle.wholesaler_id <> v_wholesaler_id THEN
            RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
        END IF;

        v_bundle_id  := v_bundle.id;
        v_product_id := v_bundle.product_id;

    ELSIF p_product_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.product_bundles WHERE product_id = p_product_id) THEN
            RAISE EXCEPTION 'ALREADY_A_BUNDLE';
        END IF;

        SELECT stock_quantity INTO v_manual_stock
        FROM public.products
        WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id AND archived_at IS NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
        END IF;

        -- kg으로 쌓인 재고와 세트 개수가 한 컬럼에서 뒤섞인다 (설계 결정 8번).
        IF public.product_has_stock_history(p_product_id) THEN
            RAISE EXCEPTION 'PRODUCT_HAS_STOCK_HISTORY';
        END IF;

        -- 수동 재고가 남아 있으면 첫 제작 때 기초재고로 편입돼 "박스 없는 세트"가 된다
        -- (2026-09-24 점검 2). 세트는 박스로만 존재해야 하므로 0으로 만든 뒤 지정하게 한다.
        IF COALESCE(v_manual_stock, 0) <> 0 THEN
            RAISE EXCEPTION 'PRODUCT_HAS_MANUAL_STOCK:%', v_manual_stock;
        END IF;

        -- 남의 세트의 구성품으로 이미 쓰이고 있으면 중첩이 된다 (설계 결정 6번).
        IF EXISTS (SELECT 1 FROM public.product_bundle_items WHERE component_product_id = p_product_id) THEN
            RAISE EXCEPTION 'COMPONENT_CANNOT_BE_BUNDLE';
        END IF;

        v_product_id := p_product_id;

    ELSE
        IF COALESCE(btrim(p_name), '') = '' THEN
            RAISE EXCEPTION 'NAME_REQUIRED';
        END IF;

        -- 축종·원산지는 구성품에서 물려받는다. 섞여 있으면 '혼합'.
        SELECT
            MIN(p.category),
            CASE WHEN COUNT(DISTINCT p.origin) = 1 THEN MIN(p.origin) ELSE '혼합' END
        INTO v_category, v_origin
        FROM jsonb_array_elements(p_items) e
        JOIN public.products p ON p.id = (e ->> 'product_id')::uuid
        WHERE p.wholesaler_id = v_wholesaler_id;

        IF v_category IS NULL THEN
            RAISE EXCEPTION 'COMPONENT_NOT_FOUND';
        END IF;

        INSERT INTO public.products (
            wholesaler_id, name, category, origin, base_price, unit,
            stock_quantity, is_active, description
        ) VALUES (
            v_wholesaler_id, btrim(p_name), v_category, v_origin,
            GREATEST(COALESCE(p_base_price, 0), 0), '세트',
            0,
            -- 자동 생성 상품과 같은 정책: 가격을 넣고 직접 켜야 노출된다(12단계).
            COALESCE(p_base_price, 0) > 0,
            NULL
        )
        RETURNING id INTO v_product_id;

        v_created := true;
    END IF;

    -- ② 자체 상품코드 ------------------------------------------------------
    v_code := upper(btrim(COALESCE(p_bundle_code, '')));

    IF v_code = '' THEN
        IF v_bundle.bundle_code IS NOT NULL THEN
            v_code := v_bundle.bundle_code;
        ELSE
            -- 업체 안에서 1번부터 센다. 동시 발급은 자문 잠금으로 막는다.
            PERFORM pg_advisory_xact_lock(hashtext('bundle_code:' || v_wholesaler_id::text));

            SELECT COUNT(*) + 1 INTO v_count
            FROM public.product_bundles WHERE wholesaler_id = v_wholesaler_id;

            v_code := 'BND-' || lpad(v_count::text, 4, '0');
        END IF;
    END IF;

    -- ③ 세트 정의 저장 -----------------------------------------------------
    IF v_bundle_id IS NULL THEN
        INSERT INTO public.product_bundles (wholesaler_id, product_id, bundle_code, memo, created_by)
        VALUES (v_wholesaler_id, v_product_id, v_code, NULLIF(btrim(COALESCE(p_memo, '')), ''), auth.uid())
        RETURNING id INTO v_bundle_id;
    ELSE
        UPDATE public.product_bundles
        SET bundle_code = v_code,
            memo = NULLIF(btrim(COALESCE(p_memo, '')), '')
        WHERE id = v_bundle_id;
    END IF;

    -- ④ 세트 상품의 단위는 '세트'로 맞춘다 (설계 결정 3번) ------------------
    UPDATE public.products SET unit = '세트' WHERE id = v_product_id AND unit <> '세트';

    -- ⑤ 구성품 교체 --------------------------------------------------------
    DELETE FROM public.product_bundle_items
    WHERE bundle_id = v_bundle_id
      AND component_product_id NOT IN (
          SELECT (e ->> 'product_id')::uuid FROM jsonb_array_elements(p_items) e
      );

    FOR v_item IN
        SELECT
            (e ->> 'product_id')::uuid AS product_id,
            COALESCE((e ->> 'quantity')::numeric, 0) AS quantity,
            (ordinality - 1)::int AS sort_order
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ordinality)
    LOOP
        IF v_item.quantity <= 0 THEN
            RAISE EXCEPTION 'INVALID_COMPONENT_QUANTITY';
        END IF;

        IF v_item.product_id = v_product_id THEN
            RAISE EXCEPTION 'SELF_COMPONENT';
        END IF;

        SELECT * INTO v_component FROM public.products WHERE id = v_item.product_id;

        IF v_component.id IS NULL
           OR v_component.wholesaler_id <> v_wholesaler_id
           OR v_component.archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'COMPONENT_NOT_FOUND';
        END IF;

        -- 세트를 구성품으로 넣는 중첩 세트는 금지 (설계 결정 6번).
        IF EXISTS (SELECT 1 FROM public.product_bundles WHERE product_id = v_item.product_id) THEN
            RAISE EXCEPTION 'NESTED_BUNDLE:%', v_component.name;
        END IF;

        INSERT INTO public.product_bundle_items (bundle_id, component_product_id, quantity, sort_order)
        VALUES (v_bundle_id, v_item.product_id, v_item.quantity, v_item.sort_order)
        ON CONFLICT (bundle_id, component_product_id) DO UPDATE
        SET quantity = EXCLUDED.quantity, sort_order = EXCLUDED.sort_order;
    END LOOP;

    RETURN jsonb_build_object(
        'bundle_id',    v_bundle_id,
        'product_id',   v_product_id,
        'bundle_code',  v_code,
        'created',      v_created,
        'buildable',    public.bundle_buildable_sets(v_bundle_id)
    );
END;
$$;


-- --------------------------------------------------------------------
-- 3. assemble_product_bundle — 보관 처리된 구성품 거부 (본문은 071과 동일)
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assemble_product_bundle(
    p_bundle_id UUID,
    p_set_count INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_bundle        public.product_bundles%ROWTYPE;
    v_set_product   public.products%ROWTYPE;
    v_item          RECORD;
    v_box           RECORD;
    v_seq           INTEGER;
    v_prefix        TEXT;
    v_index         INTEGER;
    v_assembly_id   UUID;
    v_scan_id       UUID;
    v_set_no        TEXT;
    v_need          NUMERIC(10, 3);
    v_take          NUMERIC(10, 3);
    v_available     NUMERIC(10, 3);
    v_total         NUMERIC(10, 3);
    v_best_before   DATE;
    v_plan          JSONB;
    v_sets          JSONB := '[]'::jsonb;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_bundle FROM public.product_bundles WHERE id = p_bundle_id;

    IF v_bundle.id IS NULL OR v_bundle.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
    END IF;

    IF p_set_count IS NULL OR p_set_count < 1 OR p_set_count > 200 THEN
        RAISE EXCEPTION 'INVALID_SET_COUNT';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.product_bundle_items WHERE bundle_id = p_bundle_id) THEN
        RAISE EXCEPTION 'BUNDLE_HAS_NO_ITEMS';
    END IF;

    SELECT * INTO v_set_product FROM public.products WHERE id = v_bundle.product_id;

    -- 보관 처리된 구성품이 있으면 제작하지 않는다 (2026-09-24 점검 2).
    FOR v_item IN
        SELECT p.name
        FROM public.product_bundle_items i
        JOIN public.products p ON p.id = i.component_product_id
        WHERE i.bundle_id = p_bundle_id AND p.archived_at IS NOT NULL
        ORDER BY p.name
        LIMIT 1
    LOOP
        RAISE EXCEPTION 'COMPONENT_ARCHIVED:%', v_item.name;
    END LOOP;

    -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 먼저 옮긴다(1단계 설계 결정 11번).
    PERFORM public.ensure_opening_balance(v_bundle.product_id);

    FOR v_item IN
        SELECT component_product_id FROM public.product_bundle_items WHERE bundle_id = p_bundle_id
    LOOP
        PERFORM public.ensure_opening_balance(v_item.component_product_id);
    END LOOP;

    -- 세트번호는 업체별·일자별로 1번부터 센다. 동시 제작은 자문 잠금으로 막는다.
    PERFORM pg_advisory_xact_lock(hashtext('bundle_set_no:' || v_wholesaler_id::text));

    v_prefix := 'SET-' || to_char(now(), 'YYMMDD') || '-';

    SELECT COUNT(*) INTO v_seq
    FROM public.bundle_assemblies
    WHERE wholesaler_id = v_wholesaler_id AND set_no LIKE v_prefix || '%';

    FOR v_index IN 1 .. p_set_count LOOP
        v_assembly_id := gen_random_uuid();
        v_scan_id     := gen_random_uuid();
        v_seq         := v_seq + 1;
        v_set_no      := v_prefix || lpad(v_seq::text, 3, '0');
        v_total       := 0;
        v_best_before := NULL;
        v_plan        := '[]'::jsonb;

        -- 세트 박스 한 개 = inbound_scans 한 행 (설계 결정 2번).
        INSERT INTO public.inbound_scans (
            id, wholesaler_id, trace_no, product_id, weight, unit,
            scan_type, status, remaining_weight, memo, scanned_by
        ) VALUES (
            v_scan_id, v_wholesaler_id, v_set_no, v_bundle.product_id, 1, '세트',
            'BUNDLE', 'NORMAL', 1, '세트 제작 · ' || v_bundle.bundle_code, auth.uid()
        );

        FOR v_item IN
            SELECT i.component_product_id, i.quantity, p.name
            FROM public.product_bundle_items i
            JOIN public.products p ON p.id = i.component_product_id
            WHERE i.bundle_id = p_bundle_id
            ORDER BY i.sort_order, p.name
        LOOP
            -- 박스로 채울 수 있는 양만 센다 (설계 결정 4번).
            -- 기한이 지난 박스는 세트에 넣지 않는다 (설계 결정 5번).
            SELECT COALESCE(SUM(remaining_weight), 0) INTO v_available
            FROM public.inbound_scans
            WHERE wholesaler_id = v_wholesaler_id
              AND product_id = v_item.component_product_id
              AND status = 'NORMAL'
              AND remaining_weight > 0
              AND (best_before IS NULL OR best_before >= CURRENT_DATE);

            IF v_available < v_item.quantity THEN
                RAISE EXCEPTION 'INSUFFICIENT_COMPONENT_BOXES:%:%:%',
                    v_item.name, v_available, v_item.quantity;
            END IF;

            v_need := v_item.quantity;

            FOR v_box IN
                SELECT id, trace_no, remaining_weight, best_before
                FROM public.inbound_scans
                WHERE wholesaler_id = v_wholesaler_id
                  AND product_id = v_item.component_product_id
                  AND status = 'NORMAL'
                  AND remaining_weight > 0
                  AND (best_before IS NULL OR best_before >= CURRENT_DATE)
                ORDER BY created_at, id
                FOR UPDATE
            LOOP
                EXIT WHEN v_need <= 0;

                v_take := LEAST(v_box.remaining_weight, v_need);

                UPDATE public.inbound_scans
                SET remaining_weight = remaining_weight - v_take
                WHERE id = v_box.id;

                INSERT INTO public.stock_ledger (
                    wholesaler_id, product_id, inbound_scan_id, qty_delta,
                    event_type, source_type, source_id, reason, created_by
                ) VALUES (
                    v_wholesaler_id, v_item.component_product_id, v_box.id, -v_take,
                    'BUNDLE_CONSUME', 'bundle', v_assembly_id,
                    '세트 제작 · ' || v_set_no, auth.uid()
                );

                v_plan := v_plan || jsonb_build_object(
                    'product_id', v_item.component_product_id,
                    'scan_id',    v_box.id,
                    'trace_no',   v_box.trace_no,
                    'weight',     v_take
                );

                v_total       := v_total + v_take;
                -- LEAST는 NULL을 무시한다 — 기한 없는 박스가 섞여도 가장 이른 날짜가 남는다.
                v_best_before := LEAST(v_best_before, v_box.best_before);
                v_need        := v_need - v_take;
            END LOOP;

            IF v_need > 0 THEN
                RAISE EXCEPTION 'INSUFFICIENT_COMPONENT_BOXES:%:%:%',
                    v_item.name, v_available, v_item.quantity;
            END IF;
        END LOOP;

        INSERT INTO public.bundle_assemblies (
            id, wholesaler_id, bundle_id, set_no, set_scan_id,
            total_weight, best_before, assembled_by
        ) VALUES (
            v_assembly_id, v_wholesaler_id, p_bundle_id, v_set_no, v_scan_id,
            v_total, v_best_before, auth.uid()
        );

        -- 세트 박스 ↔ 원본 이력번호 (이 기능의 전부)
        INSERT INTO public.bundle_assembly_sources (
            assembly_id, component_product_id, source_scan_id, trace_no, weight
        )
        SELECT
            v_assembly_id,
            (e ->> 'product_id')::uuid,
            (e ->> 'scan_id')::uuid,
            e ->> 'trace_no',
            (e ->> 'weight')::numeric
        FROM jsonb_array_elements(v_plan) e;

        UPDATE public.inbound_scans
        SET best_before = v_best_before
        WHERE id = v_scan_id;

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) VALUES (
            v_wholesaler_id, v_bundle.product_id, v_scan_id, 1,
            'BUNDLE_ASSEMBLE', 'bundle', v_assembly_id,
            '세트 제작 · ' || v_set_no, auth.uid()
        );

        v_sets := v_sets || jsonb_build_object(
            'assembly_id',  v_assembly_id,
            'set_no',       v_set_no,
            'total_weight', v_total,
            'best_before',  v_best_before,
            'sources',      jsonb_array_length(v_plan)
        );
    END LOOP;

    PERFORM public.recalc_product_stock(v_bundle.product_id);

    FOR v_item IN
        SELECT component_product_id FROM public.product_bundle_items WHERE bundle_id = p_bundle_id
    LOOP
        PERFORM public.recalc_product_stock(v_item.component_product_id);
    END LOOP;

    RETURN jsonb_build_object(
        'assembled',    p_set_count,
        'product_id',   v_bundle.product_id,
        'product_name', v_set_product.name,
        'sets',         v_sets,
        'buildable',    public.bundle_buildable_sets(p_bundle_id)
    );
END;
$$;
