-- 박스 폐기 이력(216)에 공급사 섞임 방어 트리거 추가 (2026-10-02, 코드 리뷰에서 발견)
--
-- 공급사 소유 표가 다른 공급사 소유 표를 가리키면 같은 마이그레이션에서 가드를 건다는 규칙(마이그 200, docs/tenant-isolation-runbook.md)을
-- 216이 놓쳤다. box_disposals.inbound_scan_id(→inbound_scans)와 product_id(→products)가 이 업체 소유인지 쓰기 때 확인한다.
-- 실제 경로(dispose_box)는 자기 업체 박스만 만들어 영향이 없었고, 이 트리거는 직접 쓰기·미래 코드의 실수를 막는다.
-- scripts/db-test-tenant-guards.sql(tenant-isolation.itest.ts)이 "누락: box_disposals.inbound_scan_id→inbound_scans"로 잡았다.

DROP TRIGGER IF EXISTS trg_box_disposals_tenant_refs ON public.box_disposals;
CREATE TRIGGER trg_box_disposals_tenant_refs
    BEFORE INSERT OR UPDATE OF wholesaler_id, inbound_scan_id, product_id ON public.box_disposals
    FOR EACH ROW EXECUTE FUNCTION public.enforce_tenant_refs('inbound_scan_id:inbound_scans', 'product_id:products');

-- 처리자 이름이 빈 문자열인 계정(카카오 닉네임이 없는 경우 등)이 폐기·조정 이력에서 이름 칸이 비어 보이던 것을
-- "알 수 없음"으로 보여준다(화면 통단테에서 발견). 본문은 216·218 그대로이고 이름 대체 한 줄만 바꿨다.
CREATE OR REPLACE FUNCTION public.list_box_disposals(p_limit integer DEFAULT 30)
RETURNS TABLE (
    id uuid, trace_no text, product_name text, reason_code text, note text,
    weight numeric, after_remaining numeric, unit_price numeric, loss_amount numeric,
    disposed_by_name text, created_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    RETURN QUERY
    SELECT d.id, d.trace_no, d.product_name, d.reason_code, d.note,
           d.weight, d.after_remaining, d.unit_price, d.loss_amount,
           COALESCE(NULLIF(btrim(pr.name), ''), '알 수 없음')::text, d.created_at
    FROM public.box_disposals d
    LEFT JOIN public.profiles pr ON pr.id = d.disposed_by
    WHERE d.wholesaler_id = v_wid
    ORDER BY d.created_at DESC, d.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 200);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_stock_adjustments(
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
           COALESCE(NULLIF(btrim(pr.name), ''), '알 수 없음')::text,
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
