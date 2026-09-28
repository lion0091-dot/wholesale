-- ====================================================================
-- 발주 확정 전 품목 수정 (바이어 자기 서비스)
--
-- 접수대기(pending) 상태의 발주서에 한해, 바이어 본인이 품목/수량/배송정보를
-- 다시 담아 같은 발주서(order_number 유지)를 갱신할 수 있게 한다. PG 결제는
-- 이미 대금이 결제됐으므로 제외한다(환불 로직 없음).
--
-- 기존 order_items INSERT 트리거(enforce_order_item_integrity, 20260930000103)가
-- 단가·소계·핫딜·총액 위조를 그대로 검증하므로 이 함수는 "삭제 후 재삽입"만 하고
-- 가격 검증 로직을 다시 만들지 않는다. 외상 미수금은 기존 총액을 먼저 되돌린 뒤
-- apply_credit_order로 새 총액을 다시 한도 검사와 함께 반영한다 — 한도 초과면
-- 이 함수 전체가 예외로 롤백되어 품목 삭제·미수금 차감도 함께 취소된다(단일
-- 트랜잭션이라 부분 실패 상태가 남지 않는다).
-- ====================================================================

CREATE OR REPLACE FUNCTION public.replace_pending_order_items(
    p_order_id uuid,
    p_items jsonb,
    p_new_total numeric,
    p_delivery_address text,
    p_delivery_notes text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
    v_relationship_id uuid;
BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;

    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF auth.role() IS DISTINCT FROM 'service_role'
       AND (v_order.retailer_id = public.get_current_retailer_id()) IS NOT TRUE THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status <> 'pending' THEN
        RAISE EXCEPTION 'ORDER_NOT_PENDING:%', v_order.status;
    END IF;

    IF v_order.payment_method = 'pg' THEN
        RAISE EXCEPTION 'PG_ORDER_NOT_EDITABLE';
    END IF;

    IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'EMPTY_ITEMS';
    END IF;

    IF p_new_total IS NULL OR p_new_total < 0 THEN
        RAISE EXCEPTION 'INVALID_TOTAL';
    END IF;

    -- 접수대기는 재고가 아직 안 움직였어야 한다(discard_unfulfilled_order와 동일 방어).
    IF EXISTS (SELECT 1 FROM public.stock_ledger WHERE source_type = 'order' AND source_id = p_order_id) THEN
        RAISE EXCEPTION 'ORDER_HAS_STOCK_MOVEMENT';
    END IF;

    -- 외상 주문이면 기존 총액만큼 미수금을 먼저 되돌린다(새 금액은 아래에서 apply_credit_order로 재적용).
    IF v_order.payment_method = 'on_credit' AND v_order.total_amount > 0 THEN
        UPDATE public.wholesaler_retailers
        SET outstanding_balance = GREATEST(0, outstanding_balance - v_order.total_amount)
        WHERE wholesaler_id = v_order.wholesaler_id AND retailer_id = v_order.retailer_id
        RETURNING id INTO v_relationship_id;
    END IF;

    -- 기존 핫딜 예약 반환(있으면) — 삭제 전에 현재 품목을 기준으로 계산해야 한다.
    IF EXISTS (SELECT 1 FROM public.hot_deal_quota_reservations WHERE order_id = p_order_id) THEN
        PERFORM public.release_hot_deal_quota(p_order_id);
        DELETE FROM public.hot_deal_quota_reservations WHERE order_id = p_order_id;
    END IF;

    DELETE FROM public.order_items WHERE order_id = p_order_id;

    -- 새 총액을 먼저 반영해야 품목 트리거의 총액 위조 방지 검사(누적 소계 <= total_amount)를 통과한다.
    UPDATE public.orders
    SET total_amount = p_new_total,
        delivery_address = COALESCE(NULLIF(p_delivery_address, ''), delivery_address),
        delivery_notes = p_delivery_notes,
        updated_at = now()
    WHERE id = p_order_id;

    INSERT INTO public.order_items (
        order_id, product_id, product_name, category, subcategory,
        unit_price, quantity, subtotal_amount, requested_unit_price, is_hot_deal
    )
    SELECT
        p_order_id,
        (item->>'productId')::uuid,
        item->>'productName',
        item->>'category',
        item->>'subcategory',
        (item->>'unitPrice')::numeric,
        (item->>'quantity')::numeric,
        (item->>'subtotalAmount')::numeric,
        NULLIF(item->>'requestedUnitPrice', '')::numeric,
        COALESCE((item->>'isHotDeal')::boolean, false)
    FROM jsonb_array_elements(p_items) AS item
    ORDER BY (item->>'productId')::uuid; -- 데드락 방지(createOrderWithItems과 동일 규칙)

    -- 바이어 세션은 위 INSERT 트리거가 핫딜 줄마다 이미 소진·예약했으므로 이 호출은 no-op이다.
    -- (createOrderWithItems과 동일한 이중 안전장치 — 트리거 미적용 경로 대비.)
    PERFORM public.reserve_hot_deal_quota(p_order_id);

    IF v_order.payment_method = 'on_credit' AND p_new_total > 0 THEN
        IF v_relationship_id IS NULL THEN
            SELECT id INTO v_relationship_id
            FROM public.wholesaler_retailers
            WHERE wholesaler_id = v_order.wholesaler_id AND retailer_id = v_order.retailer_id;
        END IF;

        -- 한도 초과면 여기서 예외가 나고, 이 함수가 단일 트랜잭션이므로 위의 품목
        -- 삭제·재삽입·미수금 반환이 전부 롤백된다(부분 실패 상태가 남지 않는다).
        PERFORM public.apply_credit_order(v_relationship_id, p_new_total);
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_pending_order_items(uuid, jsonb, numeric, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.replace_pending_order_items(uuid, jsonb, numeric, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.replace_pending_order_items(uuid, jsonb, numeric, text, text) IS
    '접수대기(pending)·PG 아닌 발주서의 품목/총액/배송정보를 바이어 본인이 통째로 교체한다. 외상이면 기존 총액을 되돌리고 새 총액을 한도 검사와 함께 재적용하며, 실패 시 전체 롤백된다.';
