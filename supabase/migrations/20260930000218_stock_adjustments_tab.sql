-- 회계 관리 > "재고 조정·손실" 탭 (2026-10-02) — 조회 전용
--
-- 재고가 주문·입고 말고 다른 이유로 바뀐 기록(상품 목록의 재고 조정, 박스 폐기, 장부 불일치 보정)을 한 곳에서 본다.
-- 새 표는 없다 — 장부(stock_ledger)의 LOSS·ADJUSTMENT 행을 읽고, 박스 폐기는 box_disposals에서 손실 금액을 붙인다.
--   · LOSS       = 폐기·파손으로 줄어든 것(상품 목록 재고 조정 "폐기/파손·손실", 박스 폐기)
--   · ADJUSTMENT = 그 밖의 조정(재고 실사·반품 입고·기타, 장부 불일치 보정)
-- 손실 금액은 박스 폐기만 안다(중량 × 매입단가, 216). 상품 단위로 한 조정은 박스를 지정하지 않아 금액이 없다 — 0원으로 치지 않고 "금액 미상"으로 따로 센다.
-- 매입단가에서 나온 금액이 들어 있어 대표 전용이다(박스 폐기 이력, 장부 불일치와 같다).
-- 이 탭은 회계 관리의 자식 기능 accounting_stock_adjust(기본 켜짐)로 켜고 끈다(217 구조).

INSERT INTO public.platform_features (key, label, description, default_enabled, parent_key) VALUES
    ('accounting_stock_adjust', '회계 관리 · 재고 조정·손실',
     '재고 조정(실사·폐기·파손·반품)과 박스 폐기, 장부 불일치 보정 기록을 한 곳에서 보고 손실 금액을 확인하는 탭입니다(대표 전용).',
     true, 'accounting')
ON CONFLICT (key) DO NOTHING;

SELECT public.open_default_feature_periods('accounting_stock_adjust');

DROP FUNCTION IF EXISTS public.list_stock_adjustments(date, date, text, integer);
DROP FUNCTION IF EXISTS public.summarize_stock_adjustments(date, date);

-- 접근 검사 한 곳: 대표이고 이 탭이 켜져 있어야 한다. 통과하면 업체 id를 돌려준다.
CREATE OR REPLACE FUNCTION public.assert_stock_adjust_access()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    IF NOT public.feature_effective(v_wid, 'accounting_stock_adjust') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    RETURN v_wid;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_stock_adjust_access() FROM PUBLIC, anon, authenticated;

-- 기록 목록(최근 순). p_kind = 'LOSS' | 'ADJUSTMENT' | NULL(전체). 날짜는 한국 시간 기준, 끝 날짜를 포함한다.
CREATE FUNCTION public.list_stock_adjustments(
    p_from date DEFAULT NULL,
    p_to date DEFAULT NULL,
    p_kind text DEFAULT NULL,
    p_limit integer DEFAULT 200
)
RETURNS TABLE (
    ledger_id    uuid,
    created_at   timestamptz,
    kind         text,
    reason       text,
    product_id   uuid,
    product_name text,
    unit         text,
    qty_delta    numeric,
    trace_no     text,
    unit_price   numeric,
    loss_amount  numeric,
    by_name      text,
    total_count  bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.assert_stock_adjust_access();
BEGIN
    IF p_kind IS NOT NULL AND p_kind NOT IN ('LOSS', 'ADJUSTMENT') THEN
        RAISE EXCEPTION 'INVALID_KIND';
    END IF;

    RETURN QUERY
    SELECT l.id,
           l.created_at,
           l.event_type,
           l.reason,
           l.product_id,
           p.name::text,
           COALESCE(p.unit, 'kg')::text,
           l.qty_delta,
           s.trace_no::text,
           d.unit_price,
           d.loss_amount,
           COALESCE(pr.name, '알 수 없음')::text,
           count(*) OVER ()
    FROM public.stock_ledger l
    JOIN public.products p ON p.id = l.product_id
    LEFT JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
    LEFT JOIN public.box_disposals d ON d.id = l.source_id AND d.wholesaler_id = v_wid
    LEFT JOIN public.profiles pr ON pr.id = l.created_by
    WHERE l.wholesaler_id = v_wid
      AND l.event_type IN ('LOSS', 'ADJUSTMENT')
      AND (p_kind IS NULL OR l.event_type = p_kind)
      AND (p_from IS NULL OR l.created_at >= (p_from::timestamp AT TIME ZONE 'Asia/Seoul'))
      AND (p_to IS NULL OR l.created_at < ((p_to + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))
    ORDER BY l.created_at DESC, l.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
END;
$$;

-- 합계: 단위별로 따로 낸다(kg과 개수를 더하지 않는다).
--   loss_qty / loss_amount          = 손실로 줄어든 양 / 그중 금액을 아는 것의 합계
--   loss_unpriced_qty               = 손실 중 금액을 모르는 양(상품 단위 조정, 단가 없는 박스)
--   adjust_in_qty / adjust_out_qty  = 조정으로 늘어난 양 / 줄어든 양
CREATE FUNCTION public.summarize_stock_adjustments(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
    unit              text,
    event_count       integer,
    loss_qty          numeric,
    loss_amount       numeric,
    loss_unpriced_qty numeric,
    adjust_in_qty     numeric,
    adjust_out_qty    numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.assert_stock_adjust_access();
BEGIN
    RETURN QUERY
    SELECT COALESCE(p.unit, 'kg')::text,
           count(*)::integer,
           COALESCE(sum(-l.qty_delta) FILTER (WHERE l.event_type = 'LOSS'), 0),
           COALESCE(sum(d.loss_amount) FILTER (WHERE l.event_type = 'LOSS'), 0),
           COALESCE(sum(-l.qty_delta) FILTER (WHERE l.event_type = 'LOSS' AND d.loss_amount IS NULL), 0),
           COALESCE(sum(l.qty_delta) FILTER (WHERE l.event_type = 'ADJUSTMENT' AND l.qty_delta > 0), 0),
           COALESCE(sum(-l.qty_delta) FILTER (WHERE l.event_type = 'ADJUSTMENT' AND l.qty_delta < 0), 0)
    FROM public.stock_ledger l
    JOIN public.products p ON p.id = l.product_id
    LEFT JOIN public.box_disposals d ON d.id = l.source_id AND d.wholesaler_id = v_wid
    WHERE l.wholesaler_id = v_wid
      AND l.event_type IN ('LOSS', 'ADJUSTMENT')
      AND (p_from IS NULL OR l.created_at >= (p_from::timestamp AT TIME ZONE 'Asia/Seoul'))
      AND (p_to IS NULL OR l.created_at < ((p_to + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))
    GROUP BY COALESCE(p.unit, 'kg')
    ORDER BY COALESCE(p.unit, 'kg');
END;
$$;

REVOKE ALL ON FUNCTION public.list_stock_adjustments(date, date, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.summarize_stock_adjustments(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_stock_adjustments(date, date, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.summarize_stock_adjustments(date, date) TO authenticated, service_role;
