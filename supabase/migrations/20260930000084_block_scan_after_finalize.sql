-- ====================================================================
-- 출고 마감(finalize_order_shipment) 이후 스캔 차단
--
-- finalize_order_shipment는 shipment_finalized_at을 찍고 금액을 확정하는데,
-- 정작 record_outbound_scan은 이 값을 전혀 확인하지 않았다. 마감 후에도
-- 주문 상태가 'shipping'으로 남아있어 출고 화면 목록에 계속 뜨고, 스캔도
-- 그대로 받아졌다 — 마감 이후 누가 박스를 더 찍으면 재고는 조용히 더
-- 빠져나가는데 청구 금액·거래명세서엔 전혀 반영되지 않는 구멍이었다.
-- (감사 결과 발견, 2026-09-23)
--
-- finalize_order_shipment가 이미 자기 자신의 중복 마감 방지에 쓰던
-- shipment_finalized_at 체크를 record_outbound_scan에도 그대로 추가한다.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.record_outbound_scan(p_order_id uuid, p_trace_no text, p_weight numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_order         public.orders%ROWTYPE;
    v_trace_no      TEXT;
    v_box           public.inbound_scans%ROWTYPE;
    v_ordered       NUMERIC(10, 3);
    v_assigned      NUMERIC(10, 3);
    v_needed        NUMERIC(10, 3);
    v_take          NUMERIC(10, 3);
    v_row           RECORD;
    v_trace_part    TEXT;
    v_product_part  TEXT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;

    IF v_order.id IS NULL OR v_order.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- 확보 대기(awaiting_stock)도 받는다. 물건이 아직 없는 주문이라 오히려
    -- 입고하면서 바로 붙일 대상이다. 이중 차감은 apply_order_shipment가
    -- 상품별 순 출고량으로 판정하도록 고쳐서 막았다(31단계).
    IF v_order.status NOT IN ('awaiting_stock', 'confirmed', 'shipping') THEN
        RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE:%', v_order.status;
    END IF;

    -- 마감(청구 금액 확정)된 주문은 더 이상 스캔을 받지 않는다. 마감 후 스캔을
    -- 허용하면 재고만 더 빠져나가고 금액·명세서에는 반영될 방법이 없다.
    IF v_order.shipment_finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'ALREADY_FINALIZED';
    END IF;

    v_trace_no := upper(btrim(COALESCE(p_trace_no, '')));

    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    SELECT * INTO v_box
    FROM public.inbound_scans
    WHERE wholesaler_id = v_wholesaler_id
      AND trace_no = v_trace_no
      AND status = 'NORMAL'
      AND remaining_weight > 0
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;

    IF v_box.id IS NULL THEN
        RAISE EXCEPTION 'BOX_NOT_AVAILABLE';
    END IF;

    -- 기한이 지난 박스는 내보내지 않는다 (설계 결정 2번). 부위 불일치와 달리
    -- 판단의 여지가 없어 확인 버튼으로 넘기게 두지 않는다.
    IF v_box.best_before IS NOT NULL AND v_box.best_before < CURRENT_DATE THEN
        RAISE EXCEPTION 'BOX_EXPIRED:%', to_char(v_box.best_before, 'YYYY-MM-DD');
    END IF;

    -- 이 상품이 이 주문에서 처음 스캔되는 거면, 그 상품의 자동 배정만 되돌린다.
    -- 주문 전체를 되돌리면(구버전) 아직 안 찍은 다른 상품의 ORDER_OUT 행까지
    -- 지워져서, 부분 스캔 상태의 명세서·마감 계산이 그 상품을 출고 0으로 본다.
    IF NOT EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id
          AND event_type = 'OUTBOUND_UNASSIGN'
          AND product_id = v_box.product_id
    ) THEN
        FOR v_row IN
            SELECT product_id, inbound_scan_id, qty_delta
            FROM public.stock_ledger
            WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_OUT'
              AND product_id = v_box.product_id
        LOOP
            IF v_row.inbound_scan_id IS NOT NULL THEN
                UPDATE public.inbound_scans
                SET remaining_weight = remaining_weight + (-v_row.qty_delta)
                WHERE id = v_row.inbound_scan_id AND status = 'NORMAL';
            END IF;

            INSERT INTO public.stock_ledger (
                wholesaler_id, product_id, inbound_scan_id, qty_delta,
                event_type, source_type, source_id, reason, created_by
            ) VALUES (
                v_wholesaler_id, v_row.product_id, v_row.inbound_scan_id, -v_row.qty_delta,
                'OUTBOUND_UNASSIGN', 'order', p_order_id, '출고 스캔으로 배정 정정', auth.uid()
            );
        END LOOP;
    END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO v_ordered
    FROM public.order_items
    WHERE order_id = p_order_id AND product_id = v_box.product_id;

    IF v_ordered <= 0 THEN
        RAISE EXCEPTION 'PRODUCT_NOT_IN_ORDER';
    END IF;

    SELECT COALESCE(SUM(-qty_delta), 0) INTO v_assigned
    FROM public.stock_ledger
    WHERE source_type = 'order' AND source_id = p_order_id
      AND event_type = 'OUTBOUND_ASSIGN'
      AND product_id = v_box.product_id;

    v_needed := v_ordered - v_assigned;

    IF v_needed <= 0 THEN
        RAISE EXCEPTION 'PRODUCT_ALREADY_FULFILLED';
    END IF;

    v_take := LEAST(v_box.remaining_weight, v_needed, COALESCE(p_weight, v_box.remaining_weight));

    IF v_take <= 0 THEN
        RAISE EXCEPTION 'INVALID_WEIGHT';
    END IF;

    UPDATE public.inbound_scans
    SET remaining_weight = remaining_weight - v_take
    WHERE id = v_box.id;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, created_by
    ) VALUES (
        v_wholesaler_id, v_box.product_id, v_box.id, -v_take,
        'OUTBOUND_ASSIGN', 'order', p_order_id, auth.uid()
    );

    PERFORM public.recalc_product_stock(v_box.product_id);

    -- 부위 대조 (막지 않고 알리기만 한다, 설계 결정 1번)
    SELECT part_name INTO v_trace_part FROM public.master_livestock WHERE trace_no = v_trace_no;
    SELECT subcategory INTO v_product_part FROM public.products WHERE id = v_box.product_id;

    RETURN jsonb_build_object(
        'trace_no', v_trace_no,
        'product_id', v_box.product_id,
        'product_name', (SELECT name FROM public.products WHERE id = v_box.product_id),
        'taken', v_take,
        'ordered', v_ordered,
        'assigned', v_assigned + v_take,
        'remaining_needed', v_needed - v_take,
        'best_before',  v_box.best_before,
        'days_left',    v_box.best_before - CURRENT_DATE,
        'part_mismatch', public.parts_conflict(v_trace_part, v_product_part),
        'trace_part', v_trace_part,
        'product_part', v_product_part
    );
END;
$function$;
