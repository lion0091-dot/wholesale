-- ====================================================================
-- 입고 실패(EXCEPTION/PENDING_MAPPING) 재시도도 중복 의심 확인창을 띄운다
--
-- 지금까지 "같은 이력번호 + 같은 중량을 10분 이내에 다시 스캔하면 되묻는다"
-- 중복검사가 NORMAL(정상 입고)에만 걸려 있었다. 그런데 이력조회 실패
-- (EXCEPTION)나 상품 미매핑(PENDING_MAPPING)으로 남은 기록도 재시도하면
-- 새 스캔 행이 또 쌓인다 — 인증키 미설정처럼 항상 실패하는 상황에서는
-- 재시도할 때마다 쓰레기 기록이 늘어난다.
--
-- 조용히 병합하지 않는 이유: 진짜 다른 박스 2개가 우연히 같은 이력번호
-- +같은 무게로 둘 다 실패하는 경우, 조용히 합치면 나중에 상품을 지정할
-- 때 박스 하나 분량이 통째로 사라지는 재고 사고가 날 수 있다. 그래서
-- NORMAL과 동일하게 "합치지 않고 매번 확인받는다" 설계를 그대로 따른다.
--
-- VOIDED는 이미 취소 처리된 기록이라 중복 후보에서 제외한다.
-- ====================================================================

DROP FUNCTION IF EXISTS public.record_inbound_scan_base(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, TEXT
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
          AND status IN ('NORMAL', 'EXCEPTION', 'PENDING_MAPPING')
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
