-- ====================================================================
-- 네고(32단계) 완성 — 공급사가 최종 확정 단가를 실제로 적용
--
-- 지금까지는 고객의 희망 단가(order_items.requested_unit_price)를 보여주기만
-- 했고, 전화로 흥정해 가격을 정해도 그걸 실제 청구 단가(unit_price)에 반영할
-- 방법이 없었다 — 원래 설계 의도("고객의 희망가와 공급사가 최종 확정한 단가가
-- 나란히 남는 것")의 절반만 구현돼 있었다(감사 결과 발견, 2026-09-23).
--
-- 매입단가(update_inbound_purchase)와 같은 원칙: owner/manager만 고칠 수 있다
-- (매출 단가도 돈이라 현장 staff에게까지 열지 않는다). 마감(출고 마감) 이후에는
-- 이미 청구 금액이 확정돼 손대면 명세서와 어긋나므로 잠근다.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.update_order_item_price(
    p_order_item_id UUID,
    p_unit_price    NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_item          public.order_items%ROWTYPE;
    v_order         public.orders%ROWTYPE;
    v_total         NUMERIC(12, 2);
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_item FROM public.order_items WHERE id = p_order_item_id;

    IF v_item.id IS NULL THEN
        RAISE EXCEPTION 'ITEM_NOT_FOUND';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = v_item.order_id FOR UPDATE;

    IF v_order.id IS NULL OR v_order.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'ITEM_NOT_FOUND';
    END IF;

    -- 매출 단가 확정도 매입단가와 동일 게이트(owner/manager만).
    IF v_wholesaler_id <> public.get_current_wholesaler_id()
       AND NOT public.is_org_staff_of_wholesaler(v_wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[]) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    -- 출고 마감 이후, 또는 이미 배송중/완료/취소로 끝난 발주는 금액이 굳어있다.
    -- 흥정은 접수~확정 사이에 끝나야 하는 절차다.
    IF v_order.shipment_finalized_at IS NOT NULL
       OR v_order.status NOT IN ('pending', 'awaiting_stock', 'confirmed') THEN
        RAISE EXCEPTION 'ORDER_LOCKED';
    END IF;

    IF p_unit_price IS NULL OR p_unit_price < 0 THEN
        RAISE EXCEPTION 'INVALID_UNIT_PRICE';
    END IF;

    UPDATE public.order_items
    SET unit_price      = p_unit_price,
        subtotal_amount = ROUND(p_unit_price * quantity, 2)
    WHERE id = p_order_item_id;

    SELECT COALESCE(SUM(subtotal_amount), 0) INTO v_total
    FROM public.order_items
    WHERE order_id = v_order.id;

    UPDATE public.orders
    SET total_amount = v_total,
        updated_at   = now()
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
        'order_item_id',      p_order_item_id,
        'unit_price',         p_unit_price,
        'subtotal_amount',    ROUND(p_unit_price * v_item.quantity, 2),
        'order_total_amount', v_total
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_order_item_price(UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_order_item_price(UUID, NUMERIC) TO authenticated;
