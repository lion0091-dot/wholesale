-- 유통기한이 없는 박스도 도축일 기준으로 보조 경고 (2026-09-24 확정)
--
-- get_expiring_boxes()(20260930000070)는 유통기한(best_before)만 본다 —
-- 바코드에 유통기한이 안 실려 오면 감시 대상에서 아예 빠진다. 유통기한은
-- 가공장이 계산해준 값이라 우선순위 1순위가 맞지만(숙성육·냉동육처럼
-- 도축일만으로는 오판할 수 있는 경우까지 감안한 값), 그게 없을 때는
-- 아무 신호도 없는 것보다 도축일이라도 보는 게 낫다.
--
-- 잠긴 설계 결정:
--   1. 유통기한이 있으면 그걸 그대로 쓴다(기존 동작 유지, 1순위).
--   2. 유통기한이 없을 때만 도축일 기준 보조 경고를 더한다 — 두 기준을
--      섞어서 하나로 합치지 않는다(숙성육 등 도축일만으론 오판 가능하므로).
--   3. "도축 후 며칠이면 위험하다"는 보편적 기준이 없으므로(부위·가공방식마다
--      다름) 고정값 대신 파라미터(p_slaughter_fallback_days, 기본 14일)로
--      느슨하게 잡고, 화면에서 "정확한 유통기한 정보 없음"이라고 구분해
--      보여줄 수 있도록 basis 컬럼을 추가한다.
-- 반환 컬럼이 늘어(basis 추가) REPLACE가 안 된다(best_before, 20260930000070과
-- 같은 이유) — 기존 시그니처를 먼저 지운다.
DROP FUNCTION IF EXISTS public.get_expiring_boxes(INTEGER);

CREATE OR REPLACE FUNCTION public.get_expiring_boxes(
    p_days INTEGER DEFAULT 3,
    p_slaughter_fallback_days INTEGER DEFAULT 14
)
RETURNS TABLE (
    box_id           UUID,
    trace_no         TEXT,
    product_id       UUID,
    product_name     TEXT,
    unit             TEXT,
    remaining_weight NUMERIC,
    best_before      DATE,
    days_left        INTEGER,
    expired          BOOLEAN,
    -- 'best_before': 유통기한 기준(정확). 'slaughter_date': 유통기한이 없어
    -- 도축일로 대신 추정한 것(부정확할 수 있음 — 숙성·냉동은 오판 가능).
    basis            TEXT
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
        s.best_before < CURRENT_DATE,
        'best_before'
    FROM public.inbound_scans s
    LEFT JOIN public.products p ON p.id = s.product_id
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
      AND s.best_before IS NOT NULL
      AND s.best_before - CURRENT_DATE <= COALESCE(p_days, 3)

    UNION ALL

    SELECT
        s.id,
        s.trace_no,
        s.product_id,
        p.name,
        COALESCE(p.unit, 'kg'),
        s.remaining_weight,
        NULL,
        NULL,
        -- 유통기한이 없으니 "지났다"는 판정 자체가 불가능하다 — 날짜만 보여준다.
        false,
        'slaughter_date'
    FROM public.inbound_scans s
    LEFT JOIN public.products p ON p.id = s.product_id
    JOIN public.master_livestock m ON m.trace_no = s.trace_no
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
      AND s.best_before IS NULL
      AND m.slaughter_date IS NOT NULL
      AND m.slaughter_date <= CURRENT_DATE - COALESCE(p_slaughter_fallback_days, 14)

    ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_expiring_boxes(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expiring_boxes(INTEGER, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.get_expiring_boxes(INTEGER, INTEGER) IS
    '유통기한 임박(기본 3일 이내) + 유통기한이 아예 없는 박스는 도축일 기준(기본 14일 경과) 보조 경고. basis 컬럼으로 두 기준을 구분한다.';
