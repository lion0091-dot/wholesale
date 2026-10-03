-- 출고 중 박스 소진 → 남은 장부 중량을 "감량"으로 기록 (2026-10-03, 사장님 결정)
--
-- 현장은 주문대로 잘라 저울에 달아 내보낸다. 박스가 장부로는 10kg인데 실제로는 9.5kg이었다면, 실중량 9.5kg을 입력해 출고하고
-- "이 박스는 다 썼음"을 체크하면 박스에 장부로 남은 0.5kg을 감량(LOSS)으로 기록하고 박스를 비운다. 부족한 0.5kg은 다른 박스를
-- 또 스캔해서 채운다(기존 흐름). 중량을 재지 않고 내보낸 박스는 지금처럼 장부 기준이고 감량은 생기지 않는다.
--
-- 박스 폐기(216)와 같은 이력 표·같은 장부 방식을 쓴다 — 사유 코드 SHRINKAGE만 늘린다. 폐기는 대표 전용이지만 감량은 출고 스캔을 하는
-- 직원이 그 자리에서 기록해야 하므로, 이 함수는 "방금 이 주문에 출고 배정한 박스"만 대상으로 한다(그 밖의 박스는 못 비운다).

ALTER TABLE public.box_disposals DROP CONSTRAINT IF EXISTS box_disposals_reason_code_check;
ALTER TABLE public.box_disposals
    ADD CONSTRAINT box_disposals_reason_code_check
    CHECK (reason_code IN ('EXPIRED', 'DAMAGE', 'SPOILED', 'OTHER', 'SHRINKAGE'));

CREATE OR REPLACE FUNCTION public.exhaust_box_after_outbound(p_order_id uuid, p_trace_no text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_wid      uuid := public.resolve_current_wholesaler_id();
    v_trace_no text := upper(btrim(COALESCE(p_trace_no, '')));
    v_order    public.orders%ROWTYPE;
    v_box      public.inbound_scans%ROWTYPE;
    v_name     text;
    v_weight   numeric(10, 3);
    v_loss     numeric;
    v_id       uuid := gen_random_uuid();
BEGIN
    IF v_wid IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;

    IF v_order.id IS NULL OR v_order.wholesaler_id <> v_wid THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    -- 이 주문에 방금 출고 배정한 박스 중 가장 최근 것. 같은 이력번호 박스가 여럿이어도 이 주문에 배정된 박스만 대상이다.
    -- 잠금 순서: 박스 → 상품 (다른 입출고 함수와 같다)
    SELECT s.* INTO v_box
    FROM public.inbound_scans s
    WHERE s.wholesaler_id = v_wid
      AND s.trace_no = v_trace_no
      AND s.status = 'NORMAL'
      AND s.product_id IS NOT NULL
      AND EXISTS (
            SELECT 1 FROM public.stock_ledger l
            WHERE l.inbound_scan_id = s.id
              AND l.source_type = 'order' AND l.source_id = p_order_id
              AND l.event_type = 'OUTBOUND_ASSIGN'
      )
    ORDER BY (
            SELECT max(l.created_at) FROM public.stock_ledger l
            WHERE l.inbound_scan_id = s.id
              AND l.source_type = 'order' AND l.source_id = p_order_id
              AND l.event_type = 'OUTBOUND_ASSIGN'
        ) DESC
    LIMIT 1
    FOR UPDATE OF s;

    IF v_box.id IS NULL THEN
        RAISE EXCEPTION 'BOX_NOT_ASSIGNED_TO_ORDER';
    END IF;

    -- 이미 비어 있으면 기록할 감량이 없다.
    IF v_box.remaining_weight <= 0 THEN
        RETURN jsonb_build_object('weight', 0, 'loss_amount', NULL);
    END IF;

    v_weight := v_box.remaining_weight;

    UPDATE public.inbound_scans SET remaining_weight = 0 WHERE id = v_box.id;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) VALUES (
        v_wid, v_box.product_id, v_box.id, -v_weight,
        'LOSS', 'manual', v_id,
        '출고 중 박스 소진(감량) — 주문 ' || COALESCE(v_order.order_number, p_order_id::text),
        auth.uid()
    );

    PERFORM public.recalc_product_stock(v_box.product_id);

    IF v_box.purchase_unit_price IS NOT NULL THEN
        v_loss := round(v_weight * v_box.purchase_unit_price, 0);
    END IF;

    SELECT p.name INTO v_name FROM public.products p WHERE p.id = v_box.product_id;

    INSERT INTO public.box_disposals (
        id, wholesaler_id, inbound_scan_id, product_id, trace_no, product_name,
        reason_code, note, weight, before_remaining, after_remaining, unit_price, loss_amount, disposed_by
    ) VALUES (
        v_id, v_wid, v_box.id, v_box.product_id, v_box.trace_no, v_name,
        'SHRINKAGE', '출고 중 박스 소진 (주문 ' || COALESCE(v_order.order_number, p_order_id::text) || ')',
        v_weight, v_weight, 0, v_box.purchase_unit_price, v_loss, auth.uid()
    );

    RETURN jsonb_build_object('weight', v_weight, 'loss_amount', v_loss);
END;
$$;

REVOKE ALL ON FUNCTION public.exhaust_box_after_outbound(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exhaust_box_after_outbound(uuid, text) TO authenticated, service_role;
