-- ====================================================================
-- 출고 마감 확인 — 실제 중량이 주문과 다르면 사람이 승인하고 금액을 맞춘다
--
-- 지금까지는 10kg 주문에 9.7kg 만 나가도 아무 일이 없었다. 경고 문구 하나
-- 없이 명세서에 10kg 이 찍히고 680,000원이 청구됐다. 축산은 박스가 딱 안
-- 떨어지는 게 예외가 아니라 일상이라, 이게 매 건 조금씩 쌓인다.
--
-- 출고를 끝낼 때 차이를 보여주고, 사람이 승인해야 배송 상태로 넘어간다.
-- 승인하면 그 순간 금액이 실제 중량 기준으로 확정된다.
--
-- 잠긴 설계 결정:
--
--  1. 주문 수량(order_items.quantity)은 고치지 않는다. 고객이 무엇을
--     주문했는지는 증거다. 실제 나간 양은 shipped_quantity 에 따로 쓴다.
--
--  2. 재고 원장은 건드리지 않는다. 이미 사실대로 적혀 있다 — 출고 스캔이
--     자동 배정을 되돌리고(OUTBOUND_UNASSIGN) 실제 박스만 배정했으므로
--     (OUTBOUND_ASSIGN) 9.7kg 만 빠진 상태다. 틀렸던 건 재고가 아니라
--     돈과 서류뿐이다.
--
--  3. 부족분은 사람이 확인해야만 통과한다(p_confirm_short). 조용히
--     깎으면 "왜 청구액이 다르냐" 는 분쟁이 나중에 터진다. 화면에서 차이를
--     보여주고 누른 것이 근거가 된다.
--
--  4. 한 상품이 여러 줄로 주문된 경우, 나간 양을 줄 순서대로 채운다.
--     비율 안분은 원 단위에서 반올림 오차가 생겨 합이 안 맞는다.
--
--  5. 초과 출고는 애초에 생기지 않는다. record_outbound_scan() 이 주문
--     수량을 넘겨 배정하지 않는다. 그래도 방어적으로 LEAST 를 건다.
-- ====================================================================

-- 실제 나간 양. NULL이면 아직 마감 전.
ALTER TABLE public.order_items
    ADD COLUMN IF NOT EXISTS shipped_quantity NUMERIC(10, 3)
    CHECK (shipped_quantity IS NULL OR shipped_quantity >= 0);

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS shipment_finalized_at TIMESTAMPTZ;


/**
 * 마감 전 미리보기 — 주문 대비 실제로 얼마가 나갔고 금액이 얼마나 바뀌는지.
 *
 * 화면에서 확인 버튼을 띄우기 위한 조회이므로 아무것도 바꾸지 않는다.
 */
CREATE OR REPLACE FUNCTION public.preview_order_shipment(p_order_id UUID)
RETURNS TABLE (
    product_id      UUID,
    product_name    TEXT,
    unit            TEXT,
    unit_price      NUMERIC,
    ordered_qty     NUMERIC,
    shipped_qty     NUMERIC,
    diff_qty        NUMERIC,
    ordered_amount  NUMERIC,
    shipped_amount  NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH authorized AS (
        SELECT o.id
        FROM public.orders o
        WHERE o.id = p_order_id
          AND (
                public.can_access_wholesaler(o.wholesaler_id)
          )
    ),
    item AS (
        SELECT
            i.product_id,
            MAX(i.product_name)  AS product_name,
            MAX(p.unit)          AS unit,
            MAX(i.unit_price)    AS unit_price,
            SUM(i.quantity)      AS ordered_qty
        FROM public.order_items i
        JOIN authorized a ON a.id = i.order_id
        LEFT JOIN public.products p ON p.id = i.product_id
        GROUP BY i.product_id
    )
    SELECT
        item.product_id,
        item.product_name,
        COALESCE(item.unit, 'kg'),
        item.unit_price,
        item.ordered_qty,
        shipped.qty,
        shipped.qty - item.ordered_qty,
        ROUND(item.unit_price * item.ordered_qty, 2),
        ROUND(item.unit_price * shipped.qty, 2)
    FROM item
    -- 출고 스캔이 있었으면 그것만, 없으면 확정 때 자동 배정분을 쓴다.
    -- 상품마다 스캔 여부가 다를 수 있어 상품 단위로 판정한다(주문 전체로 판정하면
    -- 아직 안 찍은 다른 상품이 출고량 0으로 계산된다).
    CROSS JOIN LATERAL (
        SELECT CASE
            WHEN EXISTS (
                SELECT 1 FROM public.stock_ledger x
                WHERE x.source_type = 'order' AND x.source_id = p_order_id
                  AND x.event_type = 'OUTBOUND_ASSIGN'
                  AND x.product_id = item.product_id
            ) THEN 'OUTBOUND_ASSIGN'
            ELSE 'ORDER_OUT'
        END AS event_type
    ) AS basis
    CROSS JOIN LATERAL (
        SELECT LEAST(item.ordered_qty, COALESCE((
            SELECT SUM(-l.qty_delta)
            FROM public.stock_ledger l
            WHERE l.source_type = 'order' AND l.source_id = p_order_id
              AND l.event_type = basis.event_type
              AND l.product_id = item.product_id
        ), 0)) AS qty
    ) AS shipped
    ORDER BY item.product_name;
$$;

REVOKE EXECUTE ON FUNCTION public.preview_order_shipment(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_order_shipment(UUID) TO authenticated;


/**
 * 출고 마감. 실제 중량으로 금액을 확정하고 배송 상태로 넘긴다.
 *
 * 주문보다 적게 나갔는데 p_confirm_short 가 false 면 SHIPMENT_SHORT 를
 * 던진다 — 화면이 차이를 보여주고 다시 부르게 한다 (설계 결정 3번).
 */
CREATE OR REPLACE FUNCTION public.finalize_order_shipment(
    p_order_id      UUID,
    p_confirm_short BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
                subtotal_amount  = ROUND(v_item.unit_price * v_take, 2)
            WHERE id = v_item.id;

            v_total := v_total + ROUND(v_item.unit_price * v_take, 2);
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
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_order_shipment(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_order_shipment(UUID, BOOLEAN) TO authenticated;
