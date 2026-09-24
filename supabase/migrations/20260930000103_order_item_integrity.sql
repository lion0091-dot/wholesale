-- ====================================================================
-- 주문 품목 무결성 트리거 + 실패 주문 정리 RPC (2026-09-24 점검 0 보류분, 사장님 (a)안 확정)
--
-- (1) 바이어가 서버 액션(카탈로그 가격 재해석)을 우회해 orders/order_items를 PostgREST로
--     직접 INSERT 하면 총액·단가를 마음대로 넣을 수 있었다(db-test-access-isolation.sql
--     "[보류 6번]"). 테이블 INSERT 권한은 그대로 두고, order_items BEFORE INSERT 트리거가
--     바이어 세션(auth.role() = authenticated/anon)의 행을 서버와 같은 규칙으로 대조한다:
--       - 상품이 주문의 공급사 것이고 주문 가능(활성·미보관·가격>0·발주정지 아님)
--       - 수량 > 0, 소계 = round(단가 × 수량)
--       - 핫딜 줄(is_hot_deal): 핫딜 켜짐 + 단가 = 핫딜가 + 한도 안 → 이 자리에서 판매량을
--         올리고 예약 표시(hot_deal_quota_reservations)까지 한다. 서버가 reserve_hot_deal_quota를
--         부르지 않고 품목만 넣어도 한도가 소진되게 — 한도 우회 차단.
--       - 일반 줄: 그 고객에게 켜진 맞춤단가가 있으면 그중 하나, 없으면 기준 단가
--       - 지금까지 넣은 품목 소계 합이 주문 총액을 넘으면 거부(총액을 낮춰 적는 위조 차단)
--     service_role(재대조 크론)·SECURITY DEFINER 내부·psql은 auth.role()이 그 값이 아니라
--     통과한다 — 서버 경로는 이미 카탈로그로 검증하고 들어온다.
--
-- (2) reserve_hot_deal_quota: 트리거가 이미 예약해 둔 주문이면 조용히 끝낸다(멱등).
--     102의 HOT_DEAL_ALREADY_RESERVED는 "바이어가 반복 호출해 판매량을 부풀리는" 것을
--     막기 위한 것이었고, 이제는 판매량이 안 올라가므로 오류 대신 no-op이 맞다.
--     service_role 경로(트리거 미적용)는 예약이 없으니 기존대로 여기서 소진한다.
--
-- (3) discard_unfulfilled_order: lib/orders/create-order.ts가 품목 저장·핫딜 소진에 실패하면
--     주문 헤더를 orders.delete()로 지우는데 orders에 DELETE 정책이 없어 바이어 세션에서는
--     0행으로 조용히 끝났다(핫딜 매진으로 실패한 주문이 접수대기로 남음). 소유자·접수대기·
--     한도 미소진·재고 움직임 없음일 때만 지우는 RPC로 바꾼다.
--
-- 로컬 검증: scripts/db-test-access-isolation.sql
-- ====================================================================

-- --------------------------------------------------------------------
-- (1) order_items 무결성 트리거
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_order_item_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order      public.orders%ROWTYPE;
    v_product    public.products%ROWTYPE;
    v_custom     NUMERIC[];
    v_sum_before NUMERIC;
BEGIN
    -- 바이어(또는 비로그인) 세션의 직접 INSERT만 대조한다.
    IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = NEW.order_id;
    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status <> 'pending' THEN
        RAISE EXCEPTION 'ORDER_NOT_PENDING:%', v_order.status;
    END IF;

    -- 핫딜 줄은 판매량을 올려야 하므로 상품 행을 잠근다(reserve_hot_deal_quota와 같은 원리).
    SELECT * INTO v_product FROM public.products WHERE id = NEW.product_id FOR UPDATE;
    IF v_product.id IS NULL OR v_product.wholesaler_id <> v_order.wholesaler_id THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    IF NOT v_product.is_active
       OR v_product.archived_at IS NOT NULL
       OR v_product.base_price <= 0
       OR COALESCE(v_product.order_stopped, false) THEN
        RAISE EXCEPTION 'PRODUCT_NOT_ORDERABLE';
    END IF;

    IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    IF NEW.subtotal_amount IS DISTINCT FROM ROUND(NEW.unit_price * NEW.quantity) THEN
        RAISE EXCEPTION 'SUBTOTAL_MISMATCH';
    END IF;

    IF NEW.requested_unit_price IS NOT NULL AND NEW.requested_unit_price <= 0 THEN
        RAISE EXCEPTION 'INVALID_REQUESTED_PRICE';
    END IF;

    IF NEW.is_hot_deal THEN
        IF NOT COALESCE(v_product.hot_deal_active, false) OR v_product.hot_deal_price IS NULL THEN
            RAISE EXCEPTION 'HOT_DEAL_NOT_ACTIVE';
        END IF;

        IF NEW.unit_price <> v_product.hot_deal_price THEN
            RAISE EXCEPTION 'PRICE_MISMATCH:%:%', v_product.hot_deal_price, NEW.unit_price;
        END IF;

        IF v_product.hot_deal_quantity_limit IS NOT NULL
           AND v_product.hot_deal_quantity_sold + NEW.quantity > v_product.hot_deal_quantity_limit THEN
            RAISE EXCEPTION 'HOT_DEAL_QUOTA_EXCEEDED:%:%:%:%',
                v_product.name, v_product.hot_deal_quantity_limit, v_product.hot_deal_quantity_sold, NEW.quantity;
        END IF;

        UPDATE public.products
        SET hot_deal_quantity_sold = hot_deal_quantity_sold + NEW.quantity
        WHERE id = v_product.id;

        INSERT INTO public.hot_deal_quota_reservations (order_id) VALUES (NEW.order_id)
        ON CONFLICT (order_id) DO NOTHING;
    ELSE
        SELECT COALESCE(array_agg(custom_price), '{}') INTO v_custom
        FROM public.custom_prices
        WHERE product_id = NEW.product_id
          AND retailer_id = v_order.retailer_id
          AND is_active = true;

        IF cardinality(v_custom) > 0 THEN
            IF NOT (NEW.unit_price = ANY (v_custom)) THEN
                RAISE EXCEPTION 'PRICE_MISMATCH:%:%', v_custom[1], NEW.unit_price;
            END IF;
        ELSIF NEW.unit_price <> v_product.base_price THEN
            RAISE EXCEPTION 'PRICE_MISMATCH:%:%', v_product.base_price, NEW.unit_price;
        END IF;
    END IF;

    -- 총액을 낮춰 적고 품목은 제값으로 넣는 위조 차단. (총액을 높게 적는 건 본인 손해라 안 막는다.)
    SELECT COALESCE(SUM(subtotal_amount), 0) INTO v_sum_before
    FROM public.order_items WHERE order_id = NEW.order_id;

    IF v_sum_before + NEW.subtotal_amount > v_order.total_amount THEN
        RAISE EXCEPTION 'ORDER_TOTAL_MISMATCH:%:%', v_order.total_amount, v_sum_before + NEW.subtotal_amount;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_items_integrity ON public.order_items;
CREATE TRIGGER trg_order_items_integrity
    BEFORE INSERT ON public.order_items
    FOR EACH ROW EXECUTE FUNCTION public.enforce_order_item_integrity();

COMMENT ON FUNCTION public.enforce_order_item_integrity() IS
    '바이어 세션이 넣는 주문 품목의 상품 소속·주문 가능 여부·단가(핫딜가/맞춤단가/기준가)·소계·총액을 서버 규칙으로 대조하고, 핫딜 줄은 이 자리에서 한도를 소진한다. service_role/내부 경로는 통과.';

-- --------------------------------------------------------------------
-- (2) reserve_hot_deal_quota — 이미 예약된 주문은 no-op
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_hot_deal_quota(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order   public.orders%ROWTYPE;
    v_hot     RECORD;
    v_product public.products%ROWTYPE;
BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;

    IF v_order.id IS NULL THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- 주문 소유자(바이어 세션)만. 재대조 크론은 service_role로 들어오므로 통과.
    IF auth.role() IS DISTINCT FROM 'service_role'
       AND (v_order.retailer_id = public.get_current_retailer_id()) IS NOT TRUE THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status <> 'pending' THEN
        RAISE EXCEPTION 'ORDER_NOT_PENDING:%', v_order.status;
    END IF;

    -- 품목 INSERT 트리거(바이어 경로)가 이미 소진·예약했거나, 같은 주문으로 두 번 불렸으면
    -- 판매량을 다시 올리지 않고 끝낸다. 동시 호출은 PK 삽입에서 직렬화된다.
    BEGIN
        INSERT INTO public.hot_deal_quota_reservations (order_id) VALUES (p_order_id);
    EXCEPTION WHEN unique_violation THEN
        RETURN;
    END;

    FOR v_hot IN
        SELECT product_id, SUM(quantity) AS quantity
        FROM public.order_items
        WHERE order_id = p_order_id AND is_hot_deal
        GROUP BY product_id
        ORDER BY product_id
    LOOP
        SELECT * INTO v_product FROM public.products WHERE id = v_hot.product_id FOR UPDATE;

        IF v_product.id IS NULL THEN
            RAISE EXCEPTION 'HOT_DEAL_PRODUCT_NOT_FOUND';
        END IF;

        IF v_product.hot_deal_quantity_limit IS NOT NULL
           AND v_product.hot_deal_quantity_sold + v_hot.quantity > v_product.hot_deal_quantity_limit THEN
            RAISE EXCEPTION 'HOT_DEAL_QUOTA_EXCEEDED:%:%:%:%',
                v_product.name, v_product.hot_deal_quantity_limit, v_product.hot_deal_quantity_sold, v_hot.quantity;
        END IF;

        UPDATE public.products
        SET hot_deal_quantity_sold = hot_deal_quantity_sold + v_hot.quantity
        WHERE id = v_hot.product_id;
    END LOOP;
END;
$$;

-- --------------------------------------------------------------------
-- (3) 실패 주문 정리 RPC
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discard_unfulfilled_order(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;

    IF v_order.id IS NULL THEN
        RETURN false;
    END IF;

    IF auth.role() IS DISTINCT FROM 'service_role'
       AND (v_order.retailer_id = public.get_current_retailer_id()) IS NOT TRUE THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status <> 'pending' THEN
        RAISE EXCEPTION 'ORDER_NOT_PENDING:%', v_order.status;
    END IF;

    -- 접수대기는 재고가 아직 안 움직였어야 한다(차감은 확정 시점). 혹시라도 있으면 지우지 않는다.
    IF EXISTS (SELECT 1 FROM public.stock_ledger WHERE source_type = 'order' AND source_id = p_order_id) THEN
        RAISE EXCEPTION 'ORDER_HAS_STOCK_MOVEMENT';
    END IF;

    -- 품목 트리거나 reserve_hot_deal_quota가 한도를 이미 소진했으면(외상 잔액 반영 실패 등
    -- 뒤 단계에서 실패한 경우) 돌려준다 — 취소 흐름(sync_order_stock)과 같은 함수.
    IF EXISTS (SELECT 1 FROM public.hot_deal_quota_reservations WHERE order_id = p_order_id) THEN
        PERFORM public.release_hot_deal_quota(p_order_id);
    END IF;

    DELETE FROM public.orders WHERE id = p_order_id;   -- order_items·예약 행은 FK CASCADE
    RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.discard_unfulfilled_order(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.discard_unfulfilled_order(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.discard_unfulfilled_order(UUID) IS
    '품목 저장·핫딜 소진·외상 잔액 반영에 실패한 접수대기 주문을 소유자(또는 서버)가 지운다. 소진된 핫딜 한도는 돌려주고, 재고가 움직인 주문은 거부.';
