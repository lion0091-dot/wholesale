-- 청구 수량 분리 (2026-10-04, 사장님 결정)
--
-- 박스 장부와 저울이 0.5kg쯤 어긋나는 일이 흔하다. 실제로 9.5kg이 나가도 고객에게는 주문한 10kg으로 청구하는 경우가 많다.
-- 지금까지는 출고 마감이 "실제 출고량"으로 금액을 확정해 이 둘을 따로 둘 수 없었다.
-- order_items에 청구 수량(billed_quantity)을 둔다. 실제 나간 양(shipped_quantity)은 그대로 재고·배송의뢰서·손익 수량의 기준이다.
-- 거래명세서 수량·금액(subtotal_amount)·주문 총액은 청구 수량을 따른다.
--
-- 규칙(대표 결정): 기본값은 주문 수량이다 — 부족하게 나가도 현장이 고치지 않으면 주문한 만큼 청구한다.
-- 예외: 실제로 하나도 안 나간 상품(출고량 0)은 기본 청구도 0이다.
-- 청구 수량은 0 이상, 그 상품의 주문 수량 이하만 허용한다(주문보다 더 청구하지 않는다).
-- 마감 전에 현장 누구나 마감 확인 화면에서 상품별로 고칠 수 있다.
-- 이미 마감된 주문은 billed_quantity가 NULL이고, 명세서는 NULL이면 예전처럼 shipped_quantity를 쓴다(과거 서류 불변).

ALTER TABLE public.order_items
    ADD COLUMN IF NOT EXISTS billed_quantity NUMERIC(10, 3)
    CHECK (billed_quantity IS NULL OR billed_quantity >= 0);

-- 인자가 늘어나면 같은 이름의 함수가 따로 생기므로(호출이 모호해짐) 옛 함수를 지우고 다시 만든다. 본문은 214(로컬 DB의 pg_get_functiondef) 기준.
DROP FUNCTION IF EXISTS public.finalize_order_shipment(uuid, boolean);
DROP FUNCTION IF EXISTS public.finalize_order_shipment(uuid, boolean, jsonb);

CREATE FUNCTION public.finalize_order_shipment(
    p_order_id      uuid,
    p_confirm_short boolean DEFAULT false,
    p_billed        jsonb   DEFAULT NULL
)
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
    v_billed_left   NUMERIC(10, 3);
    v_billed_take   NUMERIC(10, 3);
    v_billed_qty    NUMERIC(10, 3);
    v_total         NUMERIC(12, 2) := 0;
    v_short         BOOLEAN := false;
    v_over          INTEGER;
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

    -- 청구 수량 입력 검증: [{"product_id": "...", "qty": 9.5}, ...] — 이 주문의 상품이어야 하고 0 이상, 주문 수량 이하.
    IF p_billed IS NOT NULL THEN
        IF jsonb_typeof(p_billed) <> 'array' THEN
            RAISE EXCEPTION 'INVALID_BILLED_QTY';
        END IF;

        SELECT count(*) INTO v_over
        FROM jsonb_array_elements(p_billed) AS b
        WHERE NOT EXISTS (
                SELECT 1 FROM public.order_items i
                WHERE i.order_id = p_order_id AND i.product_id = (b ->> 'product_id')::uuid
              )
           OR (b ->> 'qty') IS NULL
           OR (b ->> 'qty')::numeric < 0
           OR (b ->> 'qty')::numeric > (
                SELECT COALESCE(sum(i.quantity), 0) FROM public.order_items i
                WHERE i.order_id = p_order_id AND i.product_id = (b ->> 'product_id')::uuid
              );

        IF v_over > 0 THEN
            RAISE EXCEPTION 'INVALID_BILLED_QTY';
        END IF;
    END IF;

    -- (1) 부족분이 있는지 먼저 본다. 있으면 확인 없이는 진행하지 않는다.
    SELECT bool_or(diff_qty < 0) INTO v_short
    FROM public.preview_order_shipment(p_order_id);

    IF COALESCE(v_short, false) AND NOT p_confirm_short THEN
        RAISE EXCEPTION 'SHIPMENT_SHORT';
    END IF;

    -- (2) 상품별로 실제 출고량(shipped_quantity)과 청구 수량(billed_quantity)을 주문 줄에 순서대로 채운다.
    --     금액은 청구 수량 기준이다. 청구 수량을 안 정했으면 주문 수량이 기본이다.
    FOR v_row IN SELECT * FROM public.preview_order_shipment(p_order_id) LOOP
        v_left := v_row.shipped_qty;

        SELECT COALESCE(
                   (SELECT (b ->> 'qty')::numeric
                    FROM jsonb_array_elements(COALESCE(p_billed, '[]'::jsonb)) AS b
                    WHERE (b ->> 'product_id')::uuid = v_row.product_id
                    LIMIT 1),
                   -- 기본은 주문 수량. 단 실제로 하나도 안 나간 상품까지 전액 청구하지는 않는다(기본 0).
                   CASE WHEN v_row.shipped_qty > 0 THEN v_row.ordered_qty ELSE 0 END)
        INTO v_billed_qty;

        v_billed_left := v_billed_qty;

        FOR v_item IN
            SELECT id, quantity, unit_price
            FROM public.order_items
            WHERE order_id = p_order_id AND product_id = v_row.product_id
            ORDER BY created_at, id
        LOOP
            v_take        := LEAST(v_item.quantity, GREATEST(v_left, 0));
            v_billed_take := LEAST(v_item.quantity, GREATEST(v_billed_left, 0));

            UPDATE public.order_items
            SET shipped_quantity = v_take,
                billed_quantity  = v_billed_take,
                subtotal_amount  = ROUND(v_item.unit_price * v_billed_take, 0)
            WHERE id = v_item.id;

            v_total       := v_total + ROUND(v_item.unit_price * v_billed_take, 0);
            v_left        := v_left - v_take;
            v_billed_left := v_billed_left - v_billed_take;
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

REVOKE ALL ON FUNCTION public.finalize_order_shipment(uuid, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_order_shipment(uuid, boolean, jsonb) TO authenticated, service_role;
