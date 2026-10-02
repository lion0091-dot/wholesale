-- ====================================================================
-- 성능 점검(2026-09-30) — DB 쪽 2건
--
-- 1. get_product_stock_boxes: product_id만 필터링해 idx_inbound_scans_available
--    (wholesaler_id, product_id, created_at) 부분 인덱스의 선두 컬럼을 못 태운다.
--    같은 상품은 항상 같은 wholesaler_id를 갖는다는 사실을 스칼라 서브쿼리로
--    명시해 인덱스를 제대로 타게 한다 — 결과는 기존과 동일(제약 조건 추가일 뿐).
--
-- 2. retry-trace-lookups 크론(매일)이 status='EXCEPTION' + lookup_retried_at
--    조건/정렬을 쓰는데 이를 받쳐줄 인덱스가 없어 계속 커지는 inbound_scans를
--    매일 풀스캔+정렬한다. 부분 인덱스로 지원한다.
-- ====================================================================

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
      AND s.wholesaler_id = (SELECT p.wholesaler_id FROM public.products p WHERE p.id = p_product_id)
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
      AND (
            public.can_access_wholesaler(s.wholesaler_id)
      )
    ORDER BY s.created_at;
$$;

CREATE INDEX IF NOT EXISTS idx_inbound_scans_exception_retry
    ON public.inbound_scans (lookup_retried_at ASC NULLS FIRST)
    WHERE status = 'EXCEPTION';
