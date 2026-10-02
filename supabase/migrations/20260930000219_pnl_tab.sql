-- 회계 관리 > "손익 관리" 탭 (2026-10-02) — 조회 전용. 매출총이익(마진) 기준이며 영업이익이 아니다.
--
-- 새 표는 없다. 이미 있는 숫자를 기간으로 모아 보여준다.
--   매출      = 출고 확정된(shipment_finalized_at) 주문 줄의 확정 금액(order_items.subtotal_amount) — 취소 주문 제외
--   매출원가  = 그 주문들에서 실제로 나간 박스의 매입단가 × 나간 양 (get_order_margin 208/210과 같은 장부 이벤트 4종·같은 계산)
--   손실 금액 = 기간 안의 장부 LOSS 중 금액을 아는 것(박스 폐기, box_disposals 216) — 재고 조정·손실 탭(218)과 같은 기준
--   원가를 모르는 출고(단가 없는 박스·박스 없는 재고)와 금액을 모르는 손실은 0원으로 치지 않고 "미입력/미상"으로 따로 센다.
--   매출 기준을 출고 확정으로 한 이유: 원가가 실제 출고 박스로 정해지는 시점이라 매출과 원가가 같은 기준이 된다.
-- 날짜는 한국 시간 기준, 끝 날짜 포함. 기본은 이번 달 1일 ~ 오늘, 최대 366일.
-- 매입단가에서 나온 금액이라 대표 전용이다. 회계 관리의 자식 기능 accounting_pnl(기본 켜짐)로 업체별로 켜고 끈다(217 구조).

INSERT INTO public.platform_features (key, label, description, default_enabled, parent_key) VALUES
    ('accounting_pnl', '회계 관리 · 손익 관리',
     '기간별 매출·매출원가·매출총이익(마진)과 폐기·손실 금액을 월별·상품별로 보는 탭입니다(대표 전용). 영업이익이 아니라 매출총이익 기준입니다.',
     true, 'accounting')
ON CONFLICT (key) DO NOTHING;

SELECT public.open_default_feature_periods('accounting_pnl');

DROP FUNCTION IF EXISTS public.get_pnl_by_month(date, date);
DROP FUNCTION IF EXISTS public.get_pnl_by_product(date, date);

-- 접근 검사 + 기간 해석 한 곳. 통과하면 업체 id와 [시작, 끝) 시각을 돌려준다.
CREATE OR REPLACE FUNCTION public.resolve_pnl_scope(p_from date, p_to date, OUT o_wid uuid, OUT o_from timestamptz, OUT o_to timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
    v_from  date := COALESCE(p_from, date_trunc('month', v_today)::date);
    v_to    date := COALESCE(p_to, v_today);
BEGIN
    o_wid := public.resolve_current_wholesaler_id();

    IF o_wid IS NULL OR NOT public.is_wholesaler_owner(o_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    IF NOT public.feature_effective(o_wid, 'accounting_pnl') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    IF v_from > v_to THEN
        RAISE EXCEPTION 'INVALID_RANGE';
    END IF;

    IF v_to - v_from > 366 THEN
        RAISE EXCEPTION 'RANGE_TOO_LONG';
    END IF;

    o_from := v_from::timestamp AT TIME ZONE 'Asia/Seoul';
    o_to := (v_to + 1)::timestamp AT TIME ZONE 'Asia/Seoul';
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_pnl_scope(date, date) FROM PUBLIC, anon, authenticated;

-- 월별(출고 확정한 달 기준). 손실은 폐기한 달 기준이라 매출 없는 달에도 줄이 생긴다.
--   unpriced_items = 그 달에 원가를 모르는 (상품) 출고 줄 수, loss_unpriced_events = 금액을 모르는 손실 기록 수
CREATE FUNCTION public.get_pnl_by_month(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
    month_start         date,
    order_count         integer,
    sales_amount        numeric,
    cost_amount         numeric,
    unpriced_items      integer,
    loss_amount         numeric,
    loss_unpriced_events integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid  uuid;
    v_from timestamptz;
    v_to   timestamptz;
BEGIN
    SELECT s.o_wid, s.o_from, s.o_to INTO v_wid, v_from, v_to FROM public.resolve_pnl_scope(p_from, p_to) s;

    RETURN QUERY
    WITH ords AS (
        SELECT o.id, date_trunc('month', o.shipment_finalized_at AT TIME ZONE 'Asia/Seoul')::date AS m
        FROM public.orders o
        WHERE o.wholesaler_id = v_wid
          AND o.shipment_finalized_at >= v_from AND o.shipment_finalized_at < v_to
          AND o.status <> 'cancelled'
    ),
    sales AS (
        SELECT ords.m, count(DISTINCT ords.id)::integer AS n, COALESCE(sum(oi.subtotal_amount), 0) AS amount
        FROM ords
        JOIN public.order_items oi ON oi.order_id = ords.id
        GROUP BY ords.m
    ),
    net AS (
        SELECT ords.m, l.product_id, l.inbound_scan_id, -sum(l.qty_delta) AS qty
        FROM ords
        JOIN public.stock_ledger l ON l.source_id = ords.id AND l.source_type = 'order'
         AND l.event_type IN ('ORDER_OUT', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN', 'ORDER_RESTORE')
        GROUP BY ords.m, l.product_id, l.inbound_scan_id
        HAVING sum(l.qty_delta) <> 0
    ),
    cost AS (
        SELECT n.m,
               COALESCE(sum(n.qty * s.purchase_unit_price) FILTER (WHERE s.purchase_unit_price IS NOT NULL), 0) AS amount,
               count(DISTINCT n.product_id) FILTER (WHERE s.purchase_unit_price IS NULL AND n.qty > 0)::integer AS unpriced
        FROM net n
        LEFT JOIN public.inbound_scans s ON s.id = n.inbound_scan_id
        GROUP BY n.m
    ),
    loss AS (
        SELECT date_trunc('month', l.created_at AT TIME ZONE 'Asia/Seoul')::date AS m,
               COALESCE(sum(d.loss_amount), 0) AS amount,
               count(*) FILTER (WHERE d.loss_amount IS NULL)::integer AS unpriced
        FROM public.stock_ledger l
        LEFT JOIN public.box_disposals d ON d.id = l.source_id AND d.wholesaler_id = v_wid
        WHERE l.wholesaler_id = v_wid AND l.event_type = 'LOSS'
          AND l.created_at >= v_from AND l.created_at < v_to
        GROUP BY 1
    ),
    months AS (
        SELECT sales.m FROM sales UNION SELECT loss.m FROM loss
    )
    SELECT months.m,
           COALESCE(sales.n, 0),
           COALESCE(sales.amount, 0),
           round(COALESCE(cost.amount, 0), 0),
           COALESCE(cost.unpriced, 0),
           COALESCE(loss.amount, 0),
           COALESCE(loss.unpriced, 0)
    FROM months
    LEFT JOIN sales ON sales.m = months.m
    LEFT JOIN cost ON cost.m = months.m
    LEFT JOIN loss ON loss.m = months.m
    ORDER BY months.m DESC;
END;
$$;

-- 상품별. 단위가 상품마다 달라 수량은 상품 줄 안에서만 의미가 있다(합치지 않는다).
CREATE FUNCTION public.get_pnl_by_product(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
    product_id        uuid,
    product_name      text,
    unit              text,
    shipped_qty       numeric,
    sales_amount      numeric,
    cost_amount       numeric,
    unpriced_qty      numeric,
    loss_qty          numeric,
    loss_amount       numeric,
    loss_unpriced_qty numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid  uuid;
    v_from timestamptz;
    v_to   timestamptz;
BEGIN
    SELECT s.o_wid, s.o_from, s.o_to INTO v_wid, v_from, v_to FROM public.resolve_pnl_scope(p_from, p_to) s;

    RETURN QUERY
    WITH ords AS (
        SELECT o.id
        FROM public.orders o
        WHERE o.wholesaler_id = v_wid
          AND o.shipment_finalized_at >= v_from AND o.shipment_finalized_at < v_to
          AND o.status <> 'cancelled'
    ),
    sales AS (
        SELECT oi.product_id, COALESCE(sum(oi.shipped_quantity), 0) AS qty, COALESCE(sum(oi.subtotal_amount), 0) AS amount
        FROM ords
        JOIN public.order_items oi ON oi.order_id = ords.id
        GROUP BY oi.product_id
    ),
    net AS (
        SELECT l.product_id, l.inbound_scan_id, -sum(l.qty_delta) AS qty
        FROM ords
        JOIN public.stock_ledger l ON l.source_id = ords.id AND l.source_type = 'order'
         AND l.event_type IN ('ORDER_OUT', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN', 'ORDER_RESTORE')
        GROUP BY l.product_id, l.inbound_scan_id
        HAVING sum(l.qty_delta) <> 0
    ),
    cost AS (
        SELECT n.product_id,
               COALESCE(sum(n.qty * s.purchase_unit_price) FILTER (WHERE s.purchase_unit_price IS NOT NULL), 0) AS amount,
               COALESCE(sum(n.qty) FILTER (WHERE s.purchase_unit_price IS NULL), 0) AS unpriced
        FROM net n
        LEFT JOIN public.inbound_scans s ON s.id = n.inbound_scan_id
        GROUP BY n.product_id
    ),
    loss AS (
        SELECT l.product_id,
               COALESCE(sum(-l.qty_delta), 0) AS qty,
               COALESCE(sum(d.loss_amount), 0) AS amount,
               COALESCE(sum(-l.qty_delta) FILTER (WHERE d.loss_amount IS NULL), 0) AS unpriced
        FROM public.stock_ledger l
        LEFT JOIN public.box_disposals d ON d.id = l.source_id AND d.wholesaler_id = v_wid
        WHERE l.wholesaler_id = v_wid AND l.event_type = 'LOSS'
          AND l.created_at >= v_from AND l.created_at < v_to
        GROUP BY l.product_id
    ),
    prods AS (
        SELECT sales.product_id FROM sales UNION SELECT loss.product_id FROM loss
    )
    SELECT p.id,
           p.name::text,
           COALESCE(p.unit, 'kg')::text,
           COALESCE(sales.qty, 0),
           COALESCE(sales.amount, 0),
           round(COALESCE(cost.amount, 0), 0),
           COALESCE(cost.unpriced, 0),
           COALESCE(loss.qty, 0),
           COALESCE(loss.amount, 0),
           COALESCE(loss.unpriced, 0)
    FROM prods
    JOIN public.products p ON p.id = prods.product_id AND p.wholesaler_id = v_wid
    LEFT JOIN sales ON sales.product_id = prods.product_id
    LEFT JOIN cost ON cost.product_id = prods.product_id
    LEFT JOIN loss ON loss.product_id = prods.product_id
    ORDER BY COALESCE(sales.amount, 0) DESC, p.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pnl_by_month(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_pnl_by_product(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pnl_by_month(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pnl_by_product(date, date) TO authenticated, service_role;
