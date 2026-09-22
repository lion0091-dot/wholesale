-- ====================================================================
-- 중복 스캔 경고
--
-- 이력번호는 소 한 마리에 하나다. 그 소에서 나온 등심 박스가 3개면 셋 다
-- 같은 번호, 같은 바코드다. 즉 "같은 바코드를 여러 번 찍는 것"이 정상이라
-- trace_no만으로는 실수로 두 번 찍은 것과 진짜 다른 박스를 구별할 수 없다.
--
-- 구별 단서는 중량이다. 박스마다 실중량이 미세하게 다르다(8.20 / 8.35).
-- 그래서 "같은 번호 + 같은 중량 + 짧은 시간 내"를 의심 신호로 삼고,
-- 작업자에게 한 번 물어본 뒤 진행한다.
--
-- 막지 않고 물어보기만 하는 이유: 실제로 같은 소에서 같은 중량 박스가 연달아
-- 나올 수 있다. 자동으로 차단하면 정상 입고를 막게 된다.
-- ====================================================================

-- 의심 판정 시간 창. 현장에서 한 박스를 찍고 다음 박스로 넘어가는 간격을
-- 넉넉히 덮으면서, 나중에 같은 규격이 또 들어오는 건 건드리지 않는 값.
CREATE OR REPLACE FUNCTION public.duplicate_scan_window()
RETURNS INTERVAL LANGUAGE sql IMMUTABLE AS $$ SELECT INTERVAL '10 minutes' $$;

CREATE OR REPLACE FUNCTION public.record_inbound_scan(
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

GRANT EXECUTE ON FUNCTION public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN
) TO authenticated;

-- 파라미터가 늘어 시그니처가 바뀌었다 — 예전 7개짜리를 지워 호출 모호성을 없앤다.
DROP FUNCTION IF EXISTS public.record_inbound_scan(TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT);

-- 중복 검사 조회 전용 인덱스 (wholesaler + trace_no + weight + 최근순).
CREATE INDEX IF NOT EXISTS idx_inbound_scans_duplicate_check
    ON public.inbound_scans (wholesaler_id, trace_no, weight, created_at DESC);
