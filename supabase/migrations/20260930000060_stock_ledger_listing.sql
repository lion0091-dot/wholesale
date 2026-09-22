-- ====================================================================
-- 입출고 원장 조회 (한 화면에서 재고 흐름 전체 보기)
--
-- 지금까지 입고는 입고 스캔 화면, 출고는 발주 관리, 조정은 기록만 남고 목록이
-- 없어서 "이 상품 재고가 왜 이 숫자인지"를 한 곳에서 추적할 수 없었다.
-- 원장(stock_ledger)에는 이미 전부 쌓이고 있으므로 조회만 붙인다.
--
-- 목록에서 상품명·이력번호·주문번호를 각각 따로 조회하면 N+1이라 조인해서
-- 한 번에 내려준다. 총건수를 같이 돌려줘 페이지네이션에 쓴다.
-- ====================================================================
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
    WITH scoped AS (
        SELECT l.*
        FROM public.stock_ledger l
        WHERE l.wholesaler_id = p_wholesaler_id
          AND (p_from IS NULL OR l.created_at >= p_from::timestamptz)
          -- 종료일은 그날 하루를 포함해야 하므로 다음 날 0시 미만으로 본다.
          AND (p_to IS NULL OR l.created_at < (p_to + 1)::timestamptz)
          AND (p_product_id IS NULL OR l.product_id = p_product_id)
          AND (p_event_types IS NULL OR l.event_type = ANY(p_event_types))
          AND (
                public.can_access_wholesaler(p_wholesaler_id)
          )
    )
    SELECT
        s.id,
        s.created_at,
        s.event_type,
        s.qty_delta,
        s.reason,
        s.product_id,
        p.name,
        p.unit,
        scan.trace_no,
        o.order_number,
        prof.name,
        (SELECT COUNT(*) FROM scoped)
    FROM scoped s
    LEFT JOIN public.products p        ON p.id = s.product_id
    LEFT JOIN public.inbound_scans scan ON scan.id = s.inbound_scan_id
    LEFT JOIN public.orders o          ON o.id = s.source_id AND s.source_type = 'order'
    LEFT JOIN public.profiles prof     ON prof.id = s.created_by
    ORDER BY s.created_at DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
    OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

REVOKE EXECUTE ON FUNCTION public.list_stock_ledger(UUID, DATE, DATE, UUID, TEXT[], INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_stock_ledger(UUID, DATE, DATE, UUID, TEXT[], INTEGER, INTEGER) TO authenticated;


-- 기간 요약 — 목록과 별개로 "이 기간에 얼마 들어오고 얼마 나갔나"를 보여준다.
CREATE OR REPLACE FUNCTION public.summarize_stock_ledger(
    p_wholesaler_id UUID,
    p_from          DATE DEFAULT NULL,
    p_to            DATE DEFAULT NULL,
    p_product_id    UUID DEFAULT NULL
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
        COALESCE(SUM(qty_delta) FILTER (WHERE event_type IN ('INBOUND', 'INBOUND_VOID', 'OPENING_BALANCE')), 0),
        COALESCE(SUM(qty_delta) FILTER (WHERE event_type IN ('ORDER_OUT', 'ORDER_RESTORE')), 0),
        COALESCE(SUM(qty_delta) FILTER (WHERE event_type = 'ADJUSTMENT'), 0),
        COALESCE(SUM(qty_delta) FILTER (WHERE event_type = 'LOSS'), 0)
    FROM public.stock_ledger
    WHERE wholesaler_id = p_wholesaler_id
      AND (p_from IS NULL OR created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR product_id = p_product_id)
      AND (
            public.can_access_wholesaler(p_wholesaler_id)
      );
$$;

REVOKE EXECUTE ON FUNCTION public.summarize_stock_ledger(UUID, DATE, DATE, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summarize_stock_ledger(UUID, DATE, DATE, UUID) TO authenticated;
