-- ====================================================================
-- 피킹 목록 — 어느 박스를 가져와야 하는지 알려준다
--
-- 지금은 작업자가 창고에서 알아서 찾아오고, 시스템은 찍은 뒤에야 맞다/틀리다를
-- 말해준다. 오래된 박스가 뒤에 묻혀 있으면 새 박스부터 나가 결국 묵은 게 남는다.
--
-- 선입선출 순서로 "이 박스에서 얼마" 를 미리 뽑아준다.
--
-- 잠긴 설계 결정:
--
--  1. 출고 스캔 전/후로 기준이 다르다.
--     - 스캔 전: 주문 확정 때 apply_order_shipment()가 이미 선입선출로 골라둔
--       ORDER_OUT 배정이 곧 추천이다. 그때 박스 잔량은 이미 깎여 있으므로
--       가용 박스를 다시 훑으면 엉뚱한 답이 나온다.
--     - 스캔 후: 자동 배정이 풀렸으므로 남은 필요량을 현재 가용 박스에서
--       선입선출로 다시 계산한다.
--
--  2. 이미 찍은 박스도 목록에 남기되 표시한다. 목록에서 사라지면 작업자가
--     "내가 이걸 찍었던가" 를 기억해야 한다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.get_picking_list(p_order_id UUID)
RETURNS TABLE (
    product_id     UUID,
    product_name   TEXT,
    unit           TEXT,
    box_id         UUID,
    trace_no       TEXT,
    suggested_qty  NUMERIC,
    box_weight     NUMERIC,
    grade          TEXT,
    slaughter_date DATE,
    scanned_at     TIMESTAMPTZ,
    already_picked BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH authorized AS (
        SELECT o.id, o.wholesaler_id
        FROM public.orders o
        WHERE o.id = p_order_id
          AND (
                public.can_access_wholesaler(o.wholesaler_id)
          )
    ),
    scan_started AS (
        SELECT EXISTS (
            SELECT 1 FROM public.stock_ledger
            WHERE source_type = 'order' AND source_id = p_order_id
              AND event_type = 'OUTBOUND_ASSIGN'
        ) AS started
    ),
    -- (A) 스캔 전 — 확정 때 잡아둔 선입선출 배정이 곧 추천이다.
    from_auto AS (
        SELECT
            l.product_id,
            p.name AS product_name,
            p.unit,
            s.id AS box_id,
            s.trace_no,
            -l.qty_delta AS suggested_qty,
            s.weight AS box_weight,
            m.grade,
            m.slaughter_date,
            s.created_at AS scanned_at,
            false AS already_picked
        FROM public.stock_ledger l
        JOIN authorized a ON a.id = l.source_id
        JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
        JOIN public.products p ON p.id = l.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
        WHERE l.source_type = 'order' AND l.source_id = p_order_id
          AND l.event_type = 'ORDER_OUT'
          AND l.inbound_scan_id IS NOT NULL
          AND NOT (SELECT started FROM scan_started)
    ),
    -- (B) 스캔 후 — 남은 필요량을 현재 가용 박스에서 선입선출로 계산한다.
    needs AS (
        SELECT
            i.product_id,
            SUM(i.quantity) AS ordered,
            COALESCE((
                SELECT SUM(-l.qty_delta)
                FROM public.stock_ledger l
                WHERE l.source_type = 'order' AND l.source_id = p_order_id
                  AND l.event_type = 'OUTBOUND_ASSIGN'
                  AND l.product_id = i.product_id
            ), 0) AS assigned
        FROM public.order_items i
        JOIN authorized a ON a.id = i.order_id
        WHERE (SELECT started FROM scan_started)
        GROUP BY i.product_id
    ),
    running AS (
        SELECT
            s.id AS box_id,
            s.product_id,
            s.trace_no,
            s.weight,
            s.remaining_weight,
            s.created_at,
            n.ordered - n.assigned AS needed,
            -- 이 박스 앞까지의 누적 — 필요량을 채우고 남는 박스는 목록에서 뺀다.
            SUM(s.remaining_weight) OVER (
                PARTITION BY s.product_id ORDER BY s.created_at, s.id
                ROWS UNBOUNDED PRECEDING
            ) - s.remaining_weight AS before_this
        FROM public.inbound_scans s
        JOIN needs n ON n.product_id = s.product_id
        JOIN authorized a ON a.wholesaler_id = s.wholesaler_id
        WHERE s.status = 'NORMAL'
          AND s.remaining_weight > 0
          AND n.ordered - n.assigned > 0
    ),
    from_remaining AS (
        SELECT
            r.product_id,
            p.name,
            p.unit,
            r.box_id,
            r.trace_no,
            LEAST(r.remaining_weight, r.needed - r.before_this) AS suggested_qty,
            r.weight,
            m.grade,
            m.slaughter_date,
            r.created_at,
            false
        FROM running r
        JOIN public.products p ON p.id = r.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = r.trace_no
        WHERE r.before_this < r.needed
    ),
    -- (C) 이미 찍은 박스 — 목록에 남겨 표시한다 (설계 결정 2번).
    already AS (
        SELECT
            l.product_id,
            p.name,
            p.unit,
            s.id,
            s.trace_no,
            -l.qty_delta,
            s.weight,
            m.grade,
            m.slaughter_date,
            s.created_at,
            true
        FROM public.stock_ledger l
        JOIN authorized a ON a.id = l.source_id
        JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
        JOIN public.products p ON p.id = l.product_id
        LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
        WHERE l.source_type = 'order' AND l.source_id = p_order_id
          AND l.event_type = 'OUTBOUND_ASSIGN'
    )
    SELECT * FROM from_auto
    UNION ALL
    SELECT * FROM from_remaining
    UNION ALL
    SELECT * FROM already
    -- 이미 찍은 건 아래로, 나머지는 오래된 순(선입선출).
    ORDER BY 11, 10;
$$;

REVOKE EXECUTE ON FUNCTION public.get_picking_list(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_picking_list(UUID) TO authenticated;
