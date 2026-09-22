-- ====================================================================
-- 상품 목록에 도축일/포장일 등 신선도 정보 노출 + 경락가 열람을 공급사로 제한
--
-- (1) 포장처리일자 컬럼 추가
--     축산물이력제 응답에 "포장처리일자"가 포함된다(스펙 기준). 20260930000053에서
--     빠져 있어 추가한다. 인증키 미발급이라 실응답으로 확인은 아직 못 했고,
--     없으면 NULL로 남을 뿐 동작에는 영향이 없다.
--
-- (2) 상품별 신선도 요약
--     상품 하나는 박스 여러 개로 채워져 있어서 도축일이 하나가 아니다.
--     목록에는 "가장 오래된 박스" 기준으로 보여준다 — 선입선출 관리에서
--     실제로 봐야 하는 값이 그것이기 때문이다(가장 오래 묵은 재고가 며칠 됐나).
--     박스별 상세는 get_product_stock_boxes()로 펼쳐본다.
--
-- (3) 경락가(market_price_snapshots) 열람 범위 축소
--     기존 정책은 로그인한 사용자 전원(authenticated)에게 열려 있었다. 비로그인
--     미니샵 손님은 원래 못 봤지만, 카카오로 로그인한 바이어(식당)는 조회가
--     가능한 상태였다. 공공 시세는 공급사의 매입가 판단용이라 고객에게는
--     노출되지 않아야 한다 — 공급사 계정과 관리자로만 좁힌다.
-- ====================================================================

-- (1) ------------------------------------------------------------------
ALTER TABLE public.master_livestock ADD COLUMN IF NOT EXISTS packing_date DATE;

CREATE OR REPLACE FUNCTION public.upsert_master_livestock(
    p_trace_no       TEXT,
    p_trace_kind     TEXT,
    p_source         TEXT,
    p_raw_payload    JSONB,
    p_species        TEXT DEFAULT NULL,
    p_species_group  TEXT DEFAULT NULL,
    p_part_name      TEXT DEFAULT NULL,
    p_grade          TEXT DEFAULT NULL,
    p_slaughter_date DATE DEFAULT NULL,
    p_butchery_place TEXT DEFAULT NULL,
    p_farm_name      TEXT DEFAULT NULL,
    p_origin_country TEXT DEFAULT NULL,
    p_importer_name  TEXT DEFAULT NULL,
    p_packing_date   DATE DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.resolve_current_wholesaler_id() IS NULL
       AND public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    INSERT INTO public.master_livestock AS m (
        trace_no, trace_kind, source, raw_payload, species, species_group,
        part_name, grade, slaughter_date, butchery_place, farm_name,
        origin_country, importer_name, packing_date, fetched_at
    ) VALUES (
        upper(trim(p_trace_no)), p_trace_kind, p_source, COALESCE(p_raw_payload, '{}'::jsonb),
        p_species, p_species_group, p_part_name, p_grade, p_slaughter_date,
        p_butchery_place, p_farm_name, p_origin_country, p_importer_name,
        p_packing_date, now()
    )
    ON CONFLICT (trace_no) DO UPDATE SET
        trace_kind     = EXCLUDED.trace_kind,
        source         = EXCLUDED.source,
        raw_payload    = EXCLUDED.raw_payload,
        species        = COALESCE(EXCLUDED.species, m.species),
        species_group  = COALESCE(EXCLUDED.species_group, m.species_group),
        part_name      = COALESCE(EXCLUDED.part_name, m.part_name),
        grade          = COALESCE(EXCLUDED.grade, m.grade),
        slaughter_date = COALESCE(EXCLUDED.slaughter_date, m.slaughter_date),
        butchery_place = COALESCE(EXCLUDED.butchery_place, m.butchery_place),
        farm_name      = COALESCE(EXCLUDED.farm_name, m.farm_name),
        origin_country = COALESCE(EXCLUDED.origin_country, m.origin_country),
        importer_name  = COALESCE(EXCLUDED.importer_name, m.importer_name),
        packing_date   = COALESCE(EXCLUDED.packing_date, m.packing_date),
        fetched_at     = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_master_livestock(
    TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, DATE
) TO authenticated;

-- 파라미터가 하나 늘어 시그니처가 바뀌었다 — 예전 13개짜리 함수를 지워 혼선을 막는다.
DROP FUNCTION IF EXISTS public.upsert_master_livestock(
    TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT
);

-- get_product_stock_boxes에도 포장일자를 실어준다.
DROP FUNCTION IF EXISTS public.get_product_stock_boxes(UUID);

CREATE OR REPLACE FUNCTION public.get_product_stock_boxes(p_product_id UUID)
RETURNS TABLE (
    scan_id          UUID,
    trace_no         TEXT,
    weight           NUMERIC,
    remaining_weight NUMERIC,
    grade            TEXT,
    slaughter_date   DATE,
    packing_date     DATE,
    butchery_place   TEXT,
    scanned_at       TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        s.id, s.trace_no, s.weight, s.remaining_weight,
        m.grade, m.slaughter_date, m.packing_date, m.butchery_place, s.created_at
    FROM public.inbound_scans s
    LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
    WHERE s.product_id = p_product_id
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
      AND (
            s.wholesaler_id = public.get_current_wholesaler_id()
         OR public.is_org_staff_of_wholesaler(s.wholesaler_id)
         OR public.get_current_role() = 'super_admin'
      )
    ORDER BY s.created_at;
$$;

REVOKE EXECUTE ON FUNCTION public.get_product_stock_boxes(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_product_stock_boxes(UUID) TO authenticated;


-- (2) ------------------------------------------------------------------
-- 상품 목록 한 번에 쓰려고 상품별 1행으로 집계해서 돌려준다 (목록 N+1 방지).
CREATE OR REPLACE FUNCTION public.get_product_stock_summary(p_wholesaler_id UUID)
RETURNS TABLE (
    product_id            UUID,
    box_count             BIGINT,
    oldest_slaughter_date DATE,
    latest_slaughter_date DATE,
    oldest_packing_date   DATE,
    grades                TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        s.product_id,
        COUNT(*),
        MIN(m.slaughter_date),
        MAX(m.slaughter_date),
        MIN(m.packing_date),
        string_agg(DISTINCT m.grade, ', ' ORDER BY m.grade)
    FROM public.inbound_scans s
    LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
    WHERE s.wholesaler_id = p_wholesaler_id
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
      AND s.product_id IS NOT NULL
      AND (
            p_wholesaler_id = public.get_current_wholesaler_id()
         OR public.is_org_staff_of_wholesaler(p_wholesaler_id)
         OR public.get_current_role() = 'super_admin'
      )
    GROUP BY s.product_id;
$$;

REVOKE EXECUTE ON FUNCTION public.get_product_stock_summary(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_product_stock_summary(UUID) TO authenticated;


-- (3) ------------------------------------------------------------------
-- 경락가는 공급사의 매입가 판단용이다. 고객(식당) 계정에는 노출하지 않는다.
DROP POLICY IF EXISTS "Market price snapshots viewable by authenticated" ON public.market_price_snapshots;

CREATE POLICY "Market price snapshots viewable by suppliers only" ON public.market_price_snapshots
    FOR SELECT TO authenticated USING (
        public.resolve_current_wholesaler_id() IS NOT NULL
        OR public.get_current_role() = 'super_admin'
    );
