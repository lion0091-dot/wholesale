-- 재고 소진 속도 기반 발주 추천.
-- 최근 실제 판매(출고) 속도로 상품별 하루 평균 소진량을 구하고, 지금 재고로 며칠을 버틸지 계산한다.
-- 판매 흐름이 없는 상품(최근 출고 0)은 추천 대상에서 제외한다 — 속도를 알 수 없어 추천이 무의미하기 때문.
CREATE OR REPLACE FUNCTION public.get_reorder_suggestions(
    p_wholesaler_id UUID,
    p_lookback_days INT DEFAULT 14,
    p_max_days_left NUMERIC DEFAULT 30
)
RETURNS TABLE (
    product_id UUID,
    product_name TEXT,
    category TEXT,
    unit TEXT,
    stock_quantity NUMERIC,
    avg_daily_outbound NUMERIC,
    days_left NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
    WITH outbound AS (
        SELECT
            l.product_id,
            GREATEST(COALESCE(SUM(-l.qty_delta), 0), 0) / GREATEST(p_lookback_days, 1) AS avg_daily_outbound
        FROM public.stock_ledger l
        WHERE l.wholesaler_id = p_wholesaler_id
          -- summarize_stock_ledger와 같은 출고 이벤트 집합(주문 확정 자동차감 또는 출고 스캔 배정 중 하나만 쌓인다).
          AND l.event_type IN ('ORDER_OUT', 'ORDER_RESTORE', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN')
          AND l.created_at >= now() - (p_lookback_days || ' days')::interval
        GROUP BY l.product_id
    )
    SELECT
        p.id,
        p.name,
        p.category,
        p.unit,
        p.stock_quantity,
        o.avg_daily_outbound,
        p.stock_quantity / o.avg_daily_outbound
    FROM public.products p
    JOIN outbound o ON o.product_id = p.id
    WHERE p.wholesaler_id = p_wholesaler_id
      AND p.archived_at IS NULL
      AND o.avg_daily_outbound > 0
      AND p.stock_quantity / o.avg_daily_outbound <= p_max_days_left
      -- 사람이 일부러 판매를 끈 상품(order_stopped_reason='manual')은 추천하지 않는다.
      -- 재고 0으로 자동정지된 상품(out_of_stock)은 계속 추천 대상이다 — 그게 바로 재입고가 급한 상품이다.
      AND NOT (p.order_stopped AND p.order_stopped_reason = 'manual')
      AND public.can_access_wholesaler(p_wholesaler_id)
    ORDER BY (p.stock_quantity / o.avg_daily_outbound) ASC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_reorder_suggestions(UUID, INT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_reorder_suggestions(UUID, INT, NUMERIC) TO authenticated;

COMMENT ON FUNCTION public.get_reorder_suggestions IS '재고 소진 속도 기반 발주 추천 — 최근 p_lookback_days일 평균 출고 속도로 상품별 재고 소진까지 남은 일수를 계산해, p_max_days_left일 이내인 상품만 급한 순으로 반환한다.';
