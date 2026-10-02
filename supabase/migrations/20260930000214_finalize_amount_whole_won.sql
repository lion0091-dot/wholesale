-- 출고 확정 금액을 원 단위로 반올림 (2026-10-02, 대표 결정: "반올림하자")
--
-- 접수 때는 단가 × 수량을 원 단위로 반올림(ROUND(..., 0), 트리거 enforce_order_item_integrity가 강제)하는데, 출고 확정은 실제 출고량으로
-- 금액을 다시 계산하면서 소수 둘째 자리까지(ROUND(..., 2)) 저장했다. 그래서 확정 뒤 항목 금액·주문 합계에 원 미만이 남을 수 있었다
-- (19,800원 × 0.834kg = 16,513.20원). 같은 규칙(원 단위 반올림)으로 통일한다. 중량·수량은 바뀌지 않는다 — 그램 그대로.
-- 함수 본문은 로컬 DB의 pg_get_functiondef 기준으로, ROUND 두 군데의 자릿수(2 → 0)만 바꾼다.
CREATE OR REPLACE FUNCTION public.finalize_order_shipment(p_order_id uuid, p_confirm_short boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_order         public.orders%ROWTYPE;
    v_row           RECORD;
    v_item          RECORD;
    v_left          NUMERIC(10, 3);
    v_take          NUMERIC(10, 3);
    v_total         NUMERIC(12, 2) := 0;
    v_short         BOOLEAN := false;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;

    IF v_order.id IS NULL OR v_order.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.shipment_finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'ALREADY_FINALIZED';
    END IF;

    IF v_order.status <> 'confirmed' THEN
        RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE:%', v_order.status;
    END IF;

    -- (1) 부족분이 있는지 먼저 본다. 있으면 확인 없이는 진행하지 않는다.
    SELECT bool_or(diff_qty < 0) INTO v_short
    FROM public.preview_order_shipment(p_order_id);

    IF COALESCE(v_short, false) AND NOT p_confirm_short THEN
        RAISE EXCEPTION 'SHIPMENT_SHORT';
    END IF;

    -- (2) 상품별 실제 출고량을 주문 줄에 순서대로 채운다 (설계 결정 4번).
    FOR v_row IN SELECT * FROM public.preview_order_shipment(p_order_id) LOOP
        v_left := v_row.shipped_qty;

        FOR v_item IN
            SELECT id, quantity, unit_price
            FROM public.order_items
            WHERE order_id = p_order_id AND product_id = v_row.product_id
            ORDER BY created_at, id
        LOOP
            v_take := LEAST(v_item.quantity, GREATEST(v_left, 0));

            UPDATE public.order_items
            SET shipped_quantity = v_take,
                subtotal_amount  = ROUND(v_item.unit_price * v_take, 0)
            WHERE id = v_item.id;

            v_total := v_total + ROUND(v_item.unit_price * v_take, 0);
            v_left  := v_left - v_take;
        END LOOP;
    END LOOP;

    -- (3) 금액 확정 + 배송 상태. 재고 원장은 건드리지 않는다 (설계 결정 2번).
    UPDATE public.orders
    SET total_amount          = v_total,
        status                = 'shipping',
        shipment_finalized_at = now(),
        updated_at            = now()
    WHERE id = p_order_id;

    RETURN jsonb_build_object(
        'order_id',     p_order_id,
        'was_short',    COALESCE(v_short, false),
        'prev_amount',  v_order.total_amount,
        'total_amount', v_total
    );
END;
$function$;
