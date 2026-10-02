-- 재고·박스·원장이 서로 맞는지 읽기만 하는 점검 (2026-10-02)
--
-- 입출고를 막지 않는다. 틀어졌는지를 매일 찾아서(크론 check-stock-integrity) 사람이 알게 하는 장치다.
-- 고치는 건 사람이 판단한다 — 과거 기록을 고치지 않고 사유가 붙은 보정 기록(조정 이벤트)을 새로 넣는 방식(docs/stock-integrity.md).
--
-- 정상이면 모든 줄이 0이다. 아래 "정상으로 보는 것"은 어긋남으로 세지 않는다:
--   · 원장 도입 전 수동 재고: 원장 행이 하나도 없는 상품은 stock_quantity가 수동 입력값이라 원장과 다른 게 정상이다
--     (첫 입출고 때 ensure_opening_balance가 원장으로 옮긴다).
--   · 확인 필요 박스(EXCEPTION·PENDING_MAPPING): 상품이 정해지기 전이라 원장에 안 들어간 게 정상이다.
-- p_wholesaler_id를 주면 그 업체만 본다(테스트·장애 조사용). 기본은 전체.
CREATE OR REPLACE FUNCTION public.stock_integrity_violations(p_wholesaler_id uuid DEFAULT NULL)
RETURNS TABLE (check_key text, label text, violations bigint, sample_ids text[])
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    WITH ledger_by_product AS (
        SELECT l.product_id, count(*) AS n, sum(l.qty_delta) AS total
        FROM public.stock_ledger l
        WHERE p_wholesaler_id IS NULL OR l.wholesaler_id = p_wholesaler_id
        GROUP BY l.product_id
    ),
    ledger_by_box AS (
        SELECT l.inbound_scan_id, count(*) AS n, sum(l.qty_delta) AS total
        FROM public.stock_ledger l
        WHERE l.inbound_scan_id IS NOT NULL
          AND (p_wholesaler_id IS NULL OR l.wholesaler_id = p_wholesaler_id)
        GROUP BY l.inbound_scan_id
    ),
    live_boxes AS (
        SELECT s.product_id, sum(s.remaining_weight) AS remaining
        FROM public.inbound_scans s
        WHERE s.status = 'NORMAL' AND s.remaining_weight > 0 AND s.product_id IS NOT NULL
          AND (p_wholesaler_id IS NULL OR s.wholesaler_id = p_wholesaler_id)
        GROUP BY s.product_id
    ),
    c1 AS (
        SELECT p.id::text AS id
        FROM public.products p
        JOIN ledger_by_product lp ON lp.product_id = p.id
        WHERE p.stock_quantity <> lp.total
          AND (p_wholesaler_id IS NULL OR p.wholesaler_id = p_wholesaler_id)
    ),
    c2 AS (
        SELECT s.id::text AS id
        FROM public.inbound_scans s
        JOIN ledger_by_box lb ON lb.inbound_scan_id = s.id
        WHERE s.remaining_weight <> lb.total
          AND (p_wholesaler_id IS NULL OR s.wholesaler_id = p_wholesaler_id)
    ),
    c3 AS (
        SELECT s.id::text AS id
        FROM public.inbound_scans s
        WHERE s.status = 'NORMAL' AND s.product_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ledger_by_box lb WHERE lb.inbound_scan_id = s.id)
          AND (p_wholesaler_id IS NULL OR s.wholesaler_id = p_wholesaler_id)
    ),
    c4 AS (
        SELECT s.id::text AS id
        FROM public.inbound_scans s
        WHERE s.remaining_weight > s.weight
          AND (p_wholesaler_id IS NULL OR s.wholesaler_id = p_wholesaler_id)
    ),
    c5 AS (
        SELECT s.id::text AS id
        FROM public.inbound_scans s
        WHERE s.status = 'VOIDED' AND s.remaining_weight > 0
          AND (p_wholesaler_id IS NULL OR s.wholesaler_id = p_wholesaler_id)
    ),
    c6 AS (
        SELECT p.id::text AS id
        FROM public.products p
        JOIN live_boxes b ON b.product_id = p.id
        WHERE b.remaining > p.stock_quantity + 0.0005
          AND (p_wholesaler_id IS NULL OR p.wholesaler_id = p_wholesaler_id)
    )
    SELECT 'product_stock_vs_ledger'::text, '상품 재고 ≠ 원장 합계 (원장이 있는 상품)'::text, count(*), COALESCE((array_agg(id))[1:3], ARRAY[]::text[]) FROM c1
    UNION ALL
    SELECT 'box_remaining_vs_ledger', '박스 잔량 ≠ 그 박스의 원장 합계', count(*), COALESCE((array_agg(id))[1:3], ARRAY[]::text[]) FROM c2
    UNION ALL
    SELECT 'normal_box_without_ledger', '입고 확정된 박스인데 원장 기록이 없음', count(*), COALESCE((array_agg(id))[1:3], ARRAY[]::text[]) FROM c3
    UNION ALL
    SELECT 'box_over_weight', '박스 잔량이 입고 중량보다 큼', count(*), COALESCE((array_agg(id))[1:3], ARRAY[]::text[]) FROM c4
    UNION ALL
    SELECT 'voided_box_with_remaining', '취소된 박스에 잔량이 남아 있음', count(*), COALESCE((array_agg(id))[1:3], ARRAY[]::text[]) FROM c5
    UNION ALL
    SELECT 'boxes_exceed_stock', '남은 박스 합계가 상품 재고보다 큼', count(*), COALESCE((array_agg(id))[1:3], ARRAY[]::text[]) FROM c6;
$$;

-- 서버(크론)와 운영자 점검 전용 — 일반 사용자·익명은 못 부른다.
REVOKE ALL ON FUNCTION public.stock_integrity_violations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_integrity_violations(uuid) TO service_role;
