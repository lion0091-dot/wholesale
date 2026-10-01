-- 199: 입출고 내역 정렬 토글 — 최신순/오래된 순. 줄마다 붙는 그 시점 재고(balance_after)는 어느 쪽이든 같다.
-- 옛 8인자 함수는 지운다(같은 이름으로 두 개 남으면 호출이 모호해진다). 본문은 로컬 DB의 pg_get_functiondef 기준.
drop function if exists public.list_stock_ledger(uuid, date, date, uuid, text[], text, integer, integer);

CREATE OR REPLACE FUNCTION public.list_stock_ledger(p_wholesaler_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_event_types text[] DEFAULT NULL::text[], p_trace_no text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_newest_first boolean DEFAULT false)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, event_type text, qty_delta numeric, balance_after numeric, reason text, product_id uuid, product_name text, product_unit text, trace_no text, order_number text, actor_name text, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
                public.can_access_wholesaler(p_wholesaler_id)
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
    -- 누적(balance_after)은 항상 오래된 순으로 계산하고, 보여주는 순서만 바꾼다.
    ORDER BY (CASE WHEN COALESCE(p_newest_first, false) THEN s.created_at END) DESC NULLS LAST,
             (CASE WHEN NOT COALESCE(p_newest_first, false) THEN s.created_at END) ASC,
             (CASE WHEN COALESCE(p_newest_first, false) THEN s.id END) DESC NULLS LAST,
             s.id
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
    OFFSET GREATEST(0, COALESCE(p_offset, 0));
$function$;

-- 권한은 062와 같게(PUBLIC·anon 회수, 로그인 사용자만).
revoke execute on function public.list_stock_ledger(uuid, date, date, uuid, text[], text, integer, integer, boolean) from public, anon;
grant execute on function public.list_stock_ledger(uuid, date, date, uuid, text[], text, integer, integer, boolean) to authenticated, service_role;
