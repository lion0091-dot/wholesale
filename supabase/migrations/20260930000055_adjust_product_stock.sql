-- ====================================================================
-- 재고 수동 조정 (상품관리 화면의 "재고 수정" 대체)
--
-- 지금까지는 products.stock_quantity를 직접 UPDATE로 덮어썼다
-- (app/dashboard/products/actions.ts의 updateProductStockAction).
-- 재고가 원장(stock_ledger) 합계로 파생되도록 바뀐 뒤로는 이 방식이 위험하다 —
-- 덮어쓴 값이 다음 입고/출고 때 recalc_product_stock()에 의해 원장 합계로
-- 되돌아가 조용히 사라진다.
--
-- 그래서 직접 UPDATE를 막고, 조정분을 원장 행으로 남긴다.
-- 왜 줄었는지(실사/폐기/파손/반품)가 기록에 남아 나중에 추적할 수 있다.
--
-- source_id는 NULL로 둔다 — 멱등 유니크 인덱스가 source_id IS NOT NULL 일 때만
-- 걸리므로, 같은 상품을 여러 번 조정하는 게 정상적으로 허용된다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.adjust_product_stock(
    p_product_id   UUID,
    p_new_quantity NUMERIC,
    p_reason_code  TEXT,
    p_reason_note  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_product       public.products%ROWTYPE;
    v_current       NUMERIC(10, 2);
    v_delta         NUMERIC(10, 2);
    v_event_type    TEXT;
    v_reason_label  TEXT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    SELECT * INTO v_product FROM public.products WHERE id = p_product_id;

    IF v_product.id IS NULL THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    IF v_product.wholesaler_id <> v_wholesaler_id
       AND public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    v_reason_label := CASE p_reason_code
        WHEN 'STOCKTAKE' THEN '재고 실사'
        WHEN 'DISPOSAL'  THEN '폐기'
        WHEN 'DAMAGE'    THEN '파손·손실'
        WHEN 'RETURN'    THEN '반품 입고'
        WHEN 'OTHER'     THEN '기타'
        ELSE NULL
    END;

    IF v_reason_label IS NULL THEN
        RAISE EXCEPTION 'INVALID_REASON';
    END IF;

    -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 기초재고로 먼저 옮긴다.
    PERFORM public.ensure_opening_balance(p_product_id);

    SELECT COALESCE(SUM(qty_delta), 0) INTO v_current
    FROM public.stock_ledger WHERE product_id = p_product_id;

    v_delta := p_new_quantity - v_current;

    IF v_delta = 0 THEN
        RETURN jsonb_build_object('changed', false, 'stock_quantity', v_current);
    END IF;

    -- 폐기/파손으로 줄어든 건 손실(LOSS)로 구분해 남긴다 — 나중에 손실률 집계에 쓴다.
    v_event_type := CASE
        WHEN v_delta < 0 AND p_reason_code IN ('DISPOSAL', 'DAMAGE') THEN 'LOSS'
        ELSE 'ADJUSTMENT'
    END;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) VALUES (
        v_product.wholesaler_id, p_product_id, NULL, v_delta,
        v_event_type, 'manual', NULL,
        v_reason_label || COALESCE(' — ' || NULLIF(btrim(p_reason_note), ''), ''),
        auth.uid()
    );

    PERFORM public.recalc_product_stock(p_product_id);

    RETURN jsonb_build_object(
        'changed', true,
        'delta', v_delta,
        'stock_quantity', p_new_quantity,
        'event_type', v_event_type
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.adjust_product_stock(UUID, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_product_stock(UUID, NUMERIC, TEXT, TEXT) TO authenticated;


-- ====================================================================
-- 상품별 박스(입고 이력) 목록 — 상품관리 화면에서 재고를 펼쳐볼 때 쓴다.
-- "이 재고가 어느 고기로 채워져 있는지"를 보여준다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.get_product_stock_boxes(p_product_id UUID)
RETURNS TABLE (
    scan_id          UUID,
    trace_no         TEXT,
    weight           NUMERIC,
    remaining_weight NUMERIC,
    grade            TEXT,
    slaughter_date   DATE,
    butchery_place   TEXT,
    scanned_at       TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        s.id, s.trace_no, s.weight, s.remaining_weight,
        m.grade, m.slaughter_date, m.butchery_place, s.created_at
    FROM public.inbound_scans s
    LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
    WHERE s.product_id = p_product_id
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
      AND (
            s.wholesaler_id = public.get_current_wholesaler_id()
         OR public.is_org_staff_of_wholesaler(s.wholesaler_id)
         OR public.get_current_role() = 'super_admin'
      )
    ORDER BY s.created_at;
$$;

REVOKE EXECUTE ON FUNCTION public.get_product_stock_boxes(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_product_stock_boxes(UUID) TO authenticated;
