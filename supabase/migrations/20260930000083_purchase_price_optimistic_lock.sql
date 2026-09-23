-- ====================================================================
-- 매입단가 수정 — 동시편집 조용한 덮어쓰기 방지 (낙관적 동시성)
--
-- owner/manager 두 명이 각자 화면(/dashboard/purchases)에서 같은 박스를
-- 동시에 열어 서로 다른 단가로 저장하면, 지금까지는 나중에 커밋된 쪽이
-- 아무 경고 없이 먼저 쓴 값을 덮어썼다. 이 화면은 실시간 동기화가 없어서
-- (Supabase Realtime 미사용) 상대방이 방금 고쳤다는 걸 알 방법이 없다.
--
-- 막지는 않는다 — 두 사람이 정말 동시에 고치는 일 자체는 드물고, 잠금을
-- 걸면 그 드문 경우 때문에 평소 흐름이 느려진다. 대신 "내가 화면을 읽은
-- 시점 이후로 아무도 안 건드렸을 때만" 저장하고, 어긋나면 조용히 덮어쓰는
-- 대신 지금 값이 뭔지 알려주고 다시 확인하게 한다.
--
-- updated_at을 버전 삼는다 — inbound_scans에 이미 touch_updated_at() 트리거가
-- 붙어 있어(20260930000053) UPDATE마다 자동으로 바뀐다. 체크와 UPDATE를
-- 한 문장(WHERE ... AND updated_at = 기대값)으로 묶어야 "확인 후 저장" 사이에
-- 또 끼어드는 경우까지 막는다 — 행 잠금이 이 WHERE 평가를 직렬화해준다.
-- ====================================================================

DROP FUNCTION IF EXISTS public.update_inbound_purchase(UUID, NUMERIC, TEXT, BOOLEAN);

CREATE FUNCTION public.update_inbound_purchase(
    p_scan_id             UUID,
    p_unit_price          NUMERIC,
    p_supplier_name       TEXT DEFAULT NULL,
    p_apply_default       BOOLEAN DEFAULT false,
    -- 화면이 마지막으로 읽었던 updated_at. NULL이면(옛 클라이언트 등) 검사를 건너뛴다.
    p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_updated_rows  INTEGER;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    IF v_scan.id IS NULL OR v_scan.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    -- 매입단가는 원가라 owner/manager만 고칠 수 있다 (set_product_purchase_price와 동일 게이트).
    IF v_wholesaler_id <> public.get_current_wholesaler_id()
       AND NOT public.is_org_staff_of_wholesaler(v_wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[]) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF p_unit_price IS NULL OR p_unit_price < 0 THEN
        RAISE EXCEPTION 'INVALID_UNIT_PRICE';
    END IF;

    UPDATE public.inbound_scans
    SET purchase_unit_price = p_unit_price,
        purchase_supplier   = COALESCE(NULLIF(btrim(COALESCE(p_supplier_name, '')), ''), purchase_supplier)
    WHERE id = p_scan_id
      AND (p_expected_updated_at IS NULL OR updated_at = p_expected_updated_at)
    RETURNING * INTO v_scan;

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

    IF v_updated_rows = 0 THEN
        -- 내가 읽은 뒤로 다른 사람이 먼저 저장했다 — 지금 값을 실어 되돌려준다.
        SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

        RAISE EXCEPTION 'PRICE_CONFLICT:%:%',
            COALESCE(v_scan.purchase_unit_price::TEXT, ''),
            to_char(v_scan.updated_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI');
    END IF;

    -- "앞으로 이 단가를 기본으로" — 같은 상품을 다음에 찍을 때 자동으로 붙는다.
    IF p_apply_default AND v_scan.product_id IS NOT NULL THEN
        INSERT INTO public.product_purchase_prices (product_id, unit_price, supplier_name)
        VALUES (v_scan.product_id, p_unit_price, v_scan.purchase_supplier)
        ON CONFLICT (product_id) DO UPDATE
        SET unit_price    = EXCLUDED.unit_price,
            supplier_name = EXCLUDED.supplier_name;
    END IF;

    RETURN jsonb_build_object(
        'scan_id',           v_scan.id,
        'purchase_unit_price', v_scan.purchase_unit_price,
        'purchase_amount',    v_scan.purchase_amount,
        'purchase_supplier',  v_scan.purchase_supplier,
        'updated_at',         v_scan.updated_at
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_inbound_purchase(UUID, NUMERIC, TEXT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_inbound_purchase(UUID, NUMERIC, TEXT, BOOLEAN, TIMESTAMPTZ) TO authenticated;


-- --------------------------------------------------------------------
-- 화면이 "내가 읽은 시점"을 저장해뒀다가 되돌려 보내야 하므로 목록 조회에도
-- updated_at을 실어 보낸다.
-- --------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_inbound_purchases(DATE, DATE, UUID, TEXT, BOOLEAN, INTEGER);

CREATE FUNCTION public.list_inbound_purchases(
    p_from       DATE    DEFAULT NULL,
    p_to         DATE    DEFAULT NULL,
    p_product_id UUID    DEFAULT NULL,
    p_supplier   TEXT    DEFAULT NULL,
    p_only_gap   BOOLEAN DEFAULT false,
    p_limit      INTEGER DEFAULT 200
)
RETURNS TABLE (
    scan_id           UUID,
    scanned_at        TIMESTAMPTZ,
    trace_no          TEXT,
    product_id        UUID,
    product_name      TEXT,
    labeled_weight    NUMERIC,
    actual_weight     NUMERIC,
    weight_variance   NUMERIC,
    variance_ratio    NUMERIC,
    unit_price        NUMERIC,
    purchase_amount   NUMERIC,
    purchase_supplier TEXT,
    status            TEXT,
    scanned_by        TEXT,
    updated_at        TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        s.id,
        s.created_at,
        s.trace_no,
        s.product_id,
        p.name,
        s.labeled_weight,
        s.weight,
        s.weight_variance,
        CASE
            WHEN s.labeled_weight IS NULL OR s.labeled_weight = 0 THEN NULL
            ELSE ROUND(s.weight_variance / s.labeled_weight, 4)
        END,
        s.purchase_unit_price,
        s.purchase_amount,
        s.purchase_supplier,
        s.status,
        pr.name,
        s.updated_at
    FROM public.inbound_scans s
    LEFT JOIN public.products p  ON p.id = s.product_id
    LEFT JOIN public.profiles pr ON pr.id = s.scanned_by
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
      AND s.status <> 'VOIDED'
      AND (p_from IS NULL OR s.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR s.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR s.product_id = p_product_id)
      AND (
            NULLIF(btrim(COALESCE(p_supplier, '')), '') IS NULL
         OR s.purchase_supplier ILIKE '%' || btrim(p_supplier) || '%'
      )
      AND (
            NOT p_only_gap
         OR (
              s.labeled_weight IS NOT NULL
              AND s.labeled_weight > 0
              AND abs(s.weight_variance / s.labeled_weight) > public.inbound_weight_tolerance()
            )
      )
    ORDER BY s.created_at DESC
    LIMIT LEAST(COALESCE(p_limit, 200), 1000);
$$;

REVOKE EXECUTE ON FUNCTION public.list_inbound_purchases(DATE, DATE, UUID, TEXT, BOOLEAN, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_inbound_purchases(DATE, DATE, UUID, TEXT, BOOLEAN, INTEGER) TO authenticated;
