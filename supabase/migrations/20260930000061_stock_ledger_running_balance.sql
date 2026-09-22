-- ====================================================================
-- 입출고 내역에 "그 시점 재고" 추가 + 오래된 순 정렬
--
-- 원장을 읽는 목적은 "재고가 왜 이 숫자인지" 추적이다. 그러려면 각 줄마다
-- 그 일이 일어난 뒤 재고가 얼마였는지가 보여야 하고, 누적을 따라가려면
-- 오래된 것부터 읽는 게 자연스럽다.
--
-- 주의할 점 두 가지:
--
--  1. 누적은 반드시 상품별로 계산한다. 여러 상품이 섞인 목록에서 전체를
--     누적하면 아무 의미 없는 숫자가 나온다.
--
--  2. 기간·유형 필터를 적용한 뒤에 누적하면 안 된다. 구간 시작 전의 재고가
--     빠져서 0부터 시작해버린다. 그래서 필터 전 전체 행에서 누적을 먼저 구하고,
--     그 다음에 걸러낸다.
-- ====================================================================
-- 위 누적합 윈도우 함수가 매 조회마다 원장 전체를 정렬해야 했다
-- (기존 idx_stock_ledger_product/idx_stock_ledger_recent 중 어느 것도
-- wholesaler_id+product_id+created_at 정렬을 그대로 커버하지 못함).
CREATE INDEX IF NOT EXISTS idx_stock_ledger_wholesaler_product_created
    ON public.stock_ledger (wholesaler_id, product_id, created_at);

DROP FUNCTION IF EXISTS public.list_stock_ledger(UUID, DATE, DATE, UUID, TEXT[], INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.list_stock_ledger(
    p_wholesaler_id UUID,
    p_from          DATE DEFAULT NULL,
    p_to            DATE DEFAULT NULL,
    p_product_id    UUID DEFAULT NULL,
    p_event_types   TEXT[] DEFAULT NULL,
    p_limit         INTEGER DEFAULT 100,
    p_offset        INTEGER DEFAULT 0
)
RETURNS TABLE (
    id            UUID,
    created_at    TIMESTAMPTZ,
    event_type    TEXT,
    qty_delta     NUMERIC,
    /** 이 일이 일어난 직후의 해당 상품 재고 */
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
        -- 누적은 필터 전 전체 행에서 구한다 (설계 주의 2번).
        SELECT
            l.*,
            SUM(l.qty_delta) OVER (
                PARTITION BY l.product_id
                ORDER BY l.created_at, l.id
                ROWS UNBOUNDED PRECEDING
            ) AS balance_after
        FROM public.stock_ledger l
        WHERE l.wholesaler_id = p_wholesaler_id
          AND (p_product_id IS NULL OR l.product_id = p_product_id)
          AND (
                public.can_access_wholesaler(p_wholesaler_id)
          )
    ),
    scoped AS (
        SELECT *
        FROM authorized a
        WHERE (p_from IS NULL OR a.created_at >= p_from::timestamptz)
          -- 종료일은 그날 하루를 포함해야 하므로 다음 날 0시 미만으로 본다.
          AND (p_to IS NULL OR a.created_at < (p_to + 1)::timestamptz)
          AND (p_event_types IS NULL OR a.event_type = ANY(p_event_types))
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
        scan.trace_no,
        o.order_number,
        prof.name,
        (SELECT COUNT(*) FROM scoped)
    FROM scoped s
    LEFT JOIN public.products p         ON p.id = s.product_id
    LEFT JOIN public.inbound_scans scan ON scan.id = s.inbound_scan_id
    LEFT JOIN public.orders o           ON o.id = s.source_id AND s.source_type = 'order'
    LEFT JOIN public.profiles prof      ON prof.id = s.created_by
    -- 누적을 따라 읽으려면 오래된 것부터가 맞다.
    ORDER BY s.created_at, s.id
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
    OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

REVOKE EXECUTE ON FUNCTION public.list_stock_ledger(UUID, DATE, DATE, UUID, TEXT[], INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_stock_ledger(UUID, DATE, DATE, UUID, TEXT[], INTEGER, INTEGER) TO authenticated;
