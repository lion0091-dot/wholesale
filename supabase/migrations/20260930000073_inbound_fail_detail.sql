-- ====================================================================
-- 이력 조회 실패 사유를 DB에 남긴다 (25단계 후속)
--
-- 지금까지 livestock_exception_log.detail은 PENDING_MAPPING일 때만 고정
-- 문구가 남고, NOT_FOUND/API_ERROR는 항상 NULL이었다. 그래서 "활용신청이
-- 아직 반영 안 된 건지" "번호가 진짜 없는 건지" DB만 봐서는 구분이 안 됐고,
-- 매번 실시간 서버 로그를 따로 봐야 했다(타이밍을 못 맞추면 그마저도 못 봄).
--
-- Server Action(app/dashboard/inbound/actions.ts)이 이미 공공 API 호출
-- 실패의 실제 메시지(MtraceError.message)를 갖고 있으므로, 그걸 그대로
-- 넘겨서 예외 로그에 남긴다.
-- ====================================================================

DROP FUNCTION IF EXISTS public.record_inbound_scan_base(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN
);

CREATE FUNCTION public.record_inbound_scan_base(
    p_trace_no          TEXT,
    p_weight            NUMERIC,
    p_scan_type         TEXT,
    p_product_id        UUID DEFAULT NULL,
    p_fail_reason       TEXT DEFAULT NULL,
    p_import_row_id     UUID DEFAULT NULL,
    p_memo              TEXT DEFAULT NULL,
    -- 작업자가 "다른 박스가 맞다"고 확인하면 true로 다시 호출한다.
    p_confirm_duplicate BOOLEAN DEFAULT false,
    -- 공공 API 호출이 실패했을 때의 실제 메시지(예: "등록되지 않은 서비스키").
    -- NOT_FOUND(호출은 성공, 결과 없음)면 보통 비어있다.
    p_fail_detail        TEXT DEFAULT NULL
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

    IF NOT p_confirm_duplicate AND p_scan_type <> 'EXCEL' THEN
        SELECT created_at INTO v_dup_at
        FROM public.inbound_scans
        WHERE wholesaler_id = v_wholesaler_id
          AND trace_no = v_trace_no
          AND weight = p_weight
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
                 ELSE p_fail_detail END
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
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_inbound_scan_base(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT
) TO authenticated;


-- --------------------------------------------------------------------
-- 바깥 껍데기(record_inbound_scan)도 p_fail_detail을 받아 그대로 넘긴다.
-- 인자 개수가 겹치면 호출이 모호해지므로 이전 12개짜리 껍데기는 지운다.
-- --------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, DATE, NUMERIC, NUMERIC, TEXT
);

CREATE FUNCTION public.record_inbound_scan(
    p_trace_no            TEXT,
    p_weight              NUMERIC,
    p_scan_type           TEXT,
    p_product_id          UUID    DEFAULT NULL,
    p_fail_reason         TEXT    DEFAULT NULL,
    p_import_row_id       UUID    DEFAULT NULL,
    p_memo                TEXT    DEFAULT NULL,
    p_confirm_duplicate   BOOLEAN DEFAULT false,
    p_best_before         DATE    DEFAULT NULL,
    p_labeled_weight      NUMERIC DEFAULT NULL,
    p_purchase_unit_price NUMERIC DEFAULT NULL,
    p_purchase_supplier   TEXT    DEFAULT NULL,
    p_fail_detail         TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result    JSONB;
    v_scan_id   UUID;
    v_scan      public.inbound_scans%ROWTYPE;
    v_default   public.product_purchase_prices%ROWTYPE;
    v_price     NUMERIC(12, 2);
    v_supplier  TEXT;
BEGIN
    v_result := public.record_inbound_scan_base(
        p_trace_no, p_weight, p_scan_type, p_product_id,
        p_fail_reason, p_import_row_id, p_memo, p_confirm_duplicate,
        p_fail_detail
    );

    v_scan_id := NULLIF(v_result ->> 'scan_id', '')::UUID;

    IF v_scan_id IS NULL THEN
        RETURN v_result;
    END IF;

    IF p_best_before IS NOT NULL THEN
        UPDATE public.inbound_scans SET best_before = p_best_before WHERE id = v_scan_id;

        v_result := v_result || jsonb_build_object(
            'best_before', p_best_before,
            'days_left',   p_best_before - CURRENT_DATE,
            'expired',     p_best_before < CURRENT_DATE
        );
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = v_scan_id;

    IF v_scan.product_id IS NOT NULL THEN
        SELECT * INTO v_default
        FROM public.product_purchase_prices WHERE product_id = v_scan.product_id;
    END IF;

    v_price    := COALESCE(p_purchase_unit_price, v_default.unit_price);
    v_supplier := COALESCE(
        NULLIF(btrim(COALESCE(p_purchase_supplier, '')), ''),
        v_default.supplier_name
    );

    UPDATE public.inbound_scans
    SET labeled_weight      = COALESCE(p_labeled_weight, labeled_weight),
        purchase_unit_price = v_price,
        purchase_supplier   = v_supplier
    WHERE id = v_scan_id
    RETURNING * INTO v_scan;

    RETURN v_result || jsonb_build_object(
        'labeled_weight',      v_scan.labeled_weight,
        'weight_variance',     v_scan.weight_variance,
        'variance_ratio',      CASE
                                   WHEN v_scan.labeled_weight IS NULL OR v_scan.labeled_weight = 0 THEN NULL
                                   ELSE ROUND(v_scan.weight_variance / v_scan.labeled_weight, 4)
                               END,
        'variance_exceeded',   CASE
                                   WHEN v_scan.labeled_weight IS NULL OR v_scan.labeled_weight = 0 THEN false
                                   ELSE abs(v_scan.weight_variance / v_scan.labeled_weight)
                                        > public.inbound_weight_tolerance()
                               END,
        'purchase_unit_price', v_scan.purchase_unit_price,
        'purchase_amount',     v_scan.purchase_amount,
        'purchase_supplier',   v_scan.purchase_supplier
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, DATE, NUMERIC, NUMERIC, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, DATE, NUMERIC, NUMERIC, TEXT, TEXT
) TO authenticated;
