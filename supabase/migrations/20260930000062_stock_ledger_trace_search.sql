-- ====================================================================
-- 입출고 내역에서 이력번호로 검색
--
-- "이 번호가 언제 들어와서 어디로 나갔나"를 한 줄 검색으로 따라갈 수 있게 한다.
-- 출고 행에도 inbound_scan_id가 있어(어느 박스가 나갔는지 기록) 같은 번호로
-- 입고와 출고가 함께 잡힌다 — 그게 이 검색의 목적이다.
--
-- 이력번호 필터는 누적(balance_after) 계산 뒤에 적용한다. 계산 전에 걸러내면
-- 그 박스 행만 남아 시점 재고가 상품 전체가 아니라 박스 하나의 누적이 돼버린다.
-- ====================================================================
DROP FUNCTION IF EXISTS public.list_stock_ledger(UUID, DATE, DATE, UUID, TEXT[], INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.list_stock_ledger(
    p_wholesaler_id UUID,
    p_from          DATE DEFAULT NULL,
    p_to            DATE DEFAULT NULL,
    p_product_id    UUID DEFAULT NULL,
    p_event_types   TEXT[] DEFAULT NULL,
    p_trace_no      TEXT DEFAULT NULL,
    p_limit         INTEGER DEFAULT 100,
    p_offset        INTEGER DEFAULT 0
)
RETURNS TABLE (
    id            UUID,
    created_at    TIMESTAMPTZ,
    event_type    TEXT,
    qty_delta     NUMERIC,
    balance_after NUMERIC,
    reason        TEXT,
    product_id    UUID,
    product_name  TEXT,
    product_unit  TEXT,
    trace_no      TEXT,
    order_number  TEXT,
    actor_name    TEXT,
    total_count   BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH authorized AS (
        -- 누적은 필터 전 전체 행에서 구한다. inbound_scans 조인은 1:1이라
        -- 행 수가 늘지 않으므로 윈도우 계산에 영향이 없다.
        SELECT
            l.*,
            scan.trace_no AS scan_trace_no,
            SUM(l.qty_delta) OVER (
                PARTITION BY l.product_id
                ORDER BY l.created_at, l.id
                ROWS UNBOUNDED PRECEDING
            ) AS balance_after
        FROM public.stock_ledger l
        LEFT JOIN public.inbound_scans scan ON scan.id = l.inbound_scan_id
        WHERE l.wholesaler_id = p_wholesaler_id
          AND (p_product_id IS NULL OR l.product_id = p_product_id)
          AND (
                p_wholesaler_id = public.get_current_wholesaler_id()
             OR public.is_org_staff_of_wholesaler(p_wholesaler_id)
             OR public.get_current_role() = 'super_admin'
          )
    ),
    scoped AS (
        SELECT *
        FROM authorized a
        WHERE (p_from IS NULL OR a.created_at >= p_from::timestamptz)
          AND (p_to IS NULL OR a.created_at < (p_to + 1)::timestamptz)
          AND (p_event_types IS NULL OR a.event_type = ANY(p_event_types))
          AND (
                NULLIF(btrim(p_trace_no), '') IS NULL
             OR a.scan_trace_no ILIKE '%' || btrim(p_trace_no) || '%'
          )
    )
    SELECT
        s.id,
        s.created_at,
        s.event_type,
        s.qty_delta,
        s.balance_after,
        s.reason,
        s.product_id,
        p.name,
        p.unit,
        s.scan_trace_no,
        o.order_number,
        prof.name,
        (SELECT COUNT(*) FROM scoped)
    FROM scoped s
    LEFT JOIN public.products p    ON p.id = s.product_id
    LEFT JOIN public.orders o      ON o.id = s.source_id AND s.source_type = 'order'
    LEFT JOIN public.profiles prof ON prof.id = s.created_by
    ORDER BY s.created_at, s.id
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
    OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

REVOKE EXECUTE ON FUNCTION public.list_stock_ledger(UUID, DATE, DATE, UUID, TEXT[], TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_stock_ledger(UUID, DATE, DATE, UUID, TEXT[], TEXT, INTEGER, INTEGER) TO authenticated;


-- 요약도 같은 조건으로 걸러야 목록과 숫자가 맞는다.
DROP FUNCTION IF EXISTS public.summarize_stock_ledger(UUID, DATE, DATE, UUID);

CREATE OR REPLACE FUNCTION public.summarize_stock_ledger(
    p_wholesaler_id UUID,
    p_from          DATE DEFAULT NULL,
    p_to            DATE DEFAULT NULL,
    p_product_id    UUID DEFAULT NULL,
    p_trace_no      TEXT DEFAULT NULL
)
RETURNS TABLE (
    inbound_qty    NUMERIC,
    outbound_qty   NUMERIC,
    adjustment_qty NUMERIC,
    loss_qty       NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN ('INBOUND', 'INBOUND_VOID', 'OPENING_BALANCE')), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN ('ORDER_OUT', 'ORDER_RESTORE')), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'ADJUSTMENT'), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'LOSS'), 0)
    FROM public.stock_ledger l
    LEFT JOIN public.inbound_scans scan ON scan.id = l.inbound_scan_id
    WHERE l.wholesaler_id = p_wholesaler_id
      AND (p_from IS NULL OR l.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR l.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR l.product_id = p_product_id)
      AND (
            NULLIF(btrim(p_trace_no), '') IS NULL
         OR scan.trace_no ILIKE '%' || btrim(p_trace_no) || '%'
      )
      AND (
            p_wholesaler_id = public.get_current_wholesaler_id()
         OR public.is_org_staff_of_wholesaler(p_wholesaler_id)
         OR public.get_current_role() = 'super_admin'
      );
$$;

REVOKE EXECUTE ON FUNCTION public.summarize_stock_ledger(UUID, DATE, DATE, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summarize_stock_ledger(UUID, DATE, DATE, UUID, TEXT) TO authenticated;
