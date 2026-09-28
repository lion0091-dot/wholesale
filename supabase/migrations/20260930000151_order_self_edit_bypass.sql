-- ====================================================================
-- 발주 수정 RPC가 트리거를 우회할 수 있는 플래그 추가
--
-- enforce_order_cancel_authority(트리거, 20260930000103 이전부터 존재)는 바이어 세션의
-- orders UPDATE를 "취소 요청" 전이 하나로만 제한하고 나머지 컬럼(총액·배송지 등)은
-- 전부 원본으로 되돌린다 — 108의 주석대로 "바이어 경로에서 취소요청 외의 컬럼을 새로
-- 쓰게 되면 이 트리거 목록도 같이 고칠 것"에 해당하는 상황이다.
--
-- replace_pending_order_items(150)가 자기 소유·접수대기·비PG 발주서인지 이미 확인한
-- 뒤에만 총액/배송정보를 갱신하므로, 그 UPDATE 문 실행 구간에서만 app.supplier_onboarding과
-- 같은 세션 플래그로 이 트리거를 건너뛴다(기존 온보딩 플래그 패턴과 동일).
-- ====================================================================

CREATE OR REPLACE FUNCTION public.enforce_order_cancel_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID := public.get_current_wholesaler_id();
    v_retailer_id   UUID := public.get_current_retailer_id();
    v_is_owner      BOOLEAN;
    v_is_buyer      BOOLEAN;
BEGIN
    -- replace_pending_order_items가 이미 소유권·상태(pending)·PG 여부를 검증한 뒤
    -- 자기 발주서를 갱신하는 구간에서만 이 트리거를 건너뛴다.
    IF COALESCE(current_setting('app.order_self_edit', true), '') = 'on' THEN
        RETURN NEW;
    END IF;

    v_is_owner := v_wholesaler_id IS NOT NULL AND v_wholesaler_id = OLD.wholesaler_id;
    v_is_buyer := v_retailer_id IS NOT NULL AND v_retailer_id = OLD.retailer_id;

    -- (A) 바이어(구매 회원) 경로: '취소 요청' 전이 하나만 허용
    IF v_is_buyer AND NOT v_is_owner THEN
        IF OLD.status NOT IN ('pending', 'confirmed') OR NEW.status <> 'cancel_requested' THEN
            RAISE EXCEPTION '바이어는 접수대기/확정 상태의 발주서에 대해 취소 요청만 생성할 수 있습니다.';
        END IF;

        -- 취소 요청과 무관한 컬럼은 원본 값으로 되돌린다 (금액·주소·결제 위조 차단).
        -- 앱의 취소요청이 쓰는 것은 status·cancel_reason·cancel_requested_at·updated_at 뿐이다.
        NEW.id                    := OLD.id;
        NEW.wholesaler_id         := OLD.wholesaler_id;
        NEW.retailer_id           := OLD.retailer_id;
        NEW.order_number          := OLD.order_number;
        NEW.total_amount          := OLD.total_amount;
        NEW.delivery_address      := OLD.delivery_address;
        NEW.delivery_notes        := OLD.delivery_notes;
        NEW.ordered_at            := OLD.ordered_at;
        NEW.cancel_resolved_at    := OLD.cancel_resolved_at;
        -- 108: 결제·배송 컬럼도 원복
        NEW.payment_method        := OLD.payment_method;
        NEW.payment_status        := OLD.payment_status;
        NEW.pg_payment_key        := OLD.pg_payment_key;
        NEW.pg_order_id           := OLD.pg_order_id;
        NEW.settled_at            := OLD.settled_at;
        NEW.courier_code          := OLD.courier_code;
        NEW.tracking_number       := OLD.tracking_number;
        NEW.shipment_finalized_at := OLD.shipment_finalized_at;
        NEW.negotiation_note      := OLD.negotiation_note;
        NEW.created_by            := OLD.created_by;

        -- 접수 시각은 클라이언트 입력이 아니라 DB 시계로 기록한다.
        NEW.cancel_requested_at := now();
        NEW.updated_at          := now();

        RETURN NEW;
    END IF;

    -- (B) 이하 공급사/관리자 경로
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    -- 취소 '요청' 생성은 바이어 전용. 공급사는 승인/반려만 한다.
    -- (lib/orders/status.ts 의 RETAILER_ONLY_STATUSES 와 동일 규칙)
    IF NEW.status = 'cancel_requested' THEN
        RAISE EXCEPTION '취소 요청은 바이어만 생성할 수 있습니다. 공급사는 승인 또는 반려만 가능합니다.';
    END IF;

    -- 취소 요청은 승인(cancelled) 또는 반려(cancel_rejected)로만 종결한다.
    IF OLD.status = 'cancel_requested' THEN
        IF NEW.status NOT IN ('cancelled', 'cancel_rejected') THEN
            RAISE EXCEPTION '취소 요청은 취소 확정 또는 반려로만 종결할 수 있습니다.';
        END IF;

        NEW.cancel_resolved_at := now();
    END IF;

    -- 외상 주문이 (미정산 상태로) 취소 확정되면 미수금 잔액을 원상복구한다.
    IF NEW.status = 'cancelled'
       AND OLD.payment_method = 'on_credit'
       AND OLD.settled_at IS NULL THEN
        UPDATE public.wholesaler_retailers
           SET outstanding_balance = GREATEST(outstanding_balance - OLD.total_amount, 0)
         WHERE wholesaler_id = OLD.wholesaler_id
           AND retailer_id = OLD.retailer_id;
    END IF;

    RETURN NEW;
END;
$function$;

-- --------------------------------------------------------------------
-- replace_pending_order_items(150) 재정의 — orders UPDATE 구간만 플래그로 감싼다.
-- --------------------------------------------------------------------
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

    -- enforce_order_cancel_authority는 바이어 세션의 orders UPDATE를 "취소 요청" 전이로만
    -- 제한한다 — 여기는 이미 위에서 소유권·상태(pending)·비PG를 확인한 뒤이므로 이 구간만
    -- 플래그로 그 트리거를 건너뛴다(app.supplier_onboarding과 동일한 기존 패턴).
    PERFORM set_config('app.order_self_edit', 'on', true);

    UPDATE public.orders
    SET total_amount = p_new_total,
        delivery_address = COALESCE(NULLIF(p_delivery_address, ''), delivery_address),
        delivery_notes = p_delivery_notes,
        updated_at = now()
    WHERE id = p_order_id;

    PERFORM set_config('app.order_self_edit', 'off', true);

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
