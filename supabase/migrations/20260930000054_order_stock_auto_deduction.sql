-- ====================================================================
-- 주문 출고 자동 차감 + 취소 시 자동 원복 (입고 시스템 2단계)
--
-- 이전까지 products.stock_quantity는 사람이 손으로 고치는 표시용 숫자였다.
-- 주문이 확정돼도, 배송이 끝나도 재고는 그대로였다
-- (app/dashboard/orders/actions.ts에 차감 코드가 아예 없었다).
-- 입고만 자동화하면 "입고는 자동 증가, 출고는 수동"이라 오차가 매일 누적되므로
-- 출고까지 원장에 묶는다.
--
-- 잠긴 설계 결정:
--
--  1. 차감 시점은 '출고(shipping)'가 아니라 '확정(confirmed)'이다.
--     출고 시점에 빼면 확정~출고 사이에 다른 거래처가 같은 물건을 주문해
--     이중 판매가 난다. 공급사가 "드리겠습니다"라고 확정한 순간 물건을 잡아야 한다.
--
--  2. Server Action이 아니라 orders 테이블 트리거로 건다.
--     상태를 바꾸는 경로가 대시보드 액션 하나가 아니다 — 운송장 등록 시
--     자동 출고 전환(actions.ts의 shouldAutoShip), PG 취소, 관리자 직접 수정이
--     모두 orders.status를 건드린다. 트리거로 걸면 어느 경로로 들어와도
--     재고가 따라간다. 외상 잔액 원복을 트리거(enforce_order_cancel_authority)로
--     처리한 20260927000000과 같은 판단이다.
--
--  3. 재고가 모자라면 확정 자체를 막는다(RAISE).
--     "상태만 바뀌고 재고는 음수"인 상태를 만드는 것보다 낫다. PG 환불 실패 시
--     취소를 막는 기존 정책(pg-payment-integration.md)과 같은 방향이다.
--
--  4. 박스가 있으면 선입선출로 박스에서 빼고(이력 추적), 모자라는 분량은
--     박스 없는 행(inbound_scan_id IS NULL)으로 뺀다.
--     스캔을 아직 안 쓰는 상품/기초재고는 박스가 없기 때문이다. 이 구조라
--     이력 관리 상품과 일반 상품이 한 주문에 섞여도 그대로 돈다.
--
--  5. 멱등성은 "이 주문에 ORDER_OUT 행이 있는가"로 판정한다.
--     cancel_rejected → confirmed 처럼 확정 상태를 다시 밟는 전이가 있어서
--     상태 전이만 보고 판단하면 이중 차감이 난다.
-- ====================================================================


-- --------------------------------------------------------------------
-- 주문 확정 시 재고 차감. 박스가 있으면 선입선출로 박스에서 뺀다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_order_shipment(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order     public.orders%ROWTYPE;
    v_item      RECORD;
    v_box       RECORD;
    v_remaining NUMERIC(10, 2);
    v_take      NUMERIC(10, 2);
    v_available NUMERIC(10, 2);
BEGIN
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
    IF v_order.id IS NULL THEN
        RETURN;
    END IF;

    -- 이미 차감된 주문이면 아무것도 하지 않는다 (설계 결정 5번).
    IF EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_OUT'
    ) THEN
        RETURN;
    END IF;

    FOR v_item IN
        SELECT product_id, SUM(quantity) AS quantity, MAX(product_name) AS product_name
        FROM public.order_items
        WHERE order_id = p_order_id
        GROUP BY product_id
    LOOP
        -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 기초재고로 옮긴다.
        PERFORM public.ensure_opening_balance(v_item.product_id);

        SELECT COALESCE(SUM(qty_delta), 0) INTO v_available
        FROM public.stock_ledger WHERE product_id = v_item.product_id;

        IF v_available < v_item.quantity THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%',
                v_item.product_name, v_available, v_item.quantity;
        END IF;

        v_remaining := v_item.quantity;

        -- (a) 이력 추적되는 박스에서 선입선출로 뺀다.
        FOR v_box IN
            SELECT id, remaining_weight
            FROM public.inbound_scans
            WHERE wholesaler_id = v_order.wholesaler_id
              AND product_id = v_item.product_id
              AND status = 'NORMAL'
              AND remaining_weight > 0
            ORDER BY created_at
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            v_take := LEAST(v_box.remaining_weight, v_remaining);

            UPDATE public.inbound_scans
            SET remaining_weight = remaining_weight - v_take
            WHERE id = v_box.id;

            INSERT INTO public.stock_ledger (
                wholesaler_id, product_id, inbound_scan_id, qty_delta,
                event_type, source_type, source_id, created_by
            ) VALUES (
                v_order.wholesaler_id, v_item.product_id, v_box.id, -v_take,
                'ORDER_OUT', 'order', p_order_id, auth.uid()
            );

            v_remaining := v_remaining - v_take;
        END LOOP;

        -- (b) 박스로 못 채운 분량(기초재고/스캔 미사용 상품)은 박스 없이 뺀다.
        IF v_remaining > 0 THEN
            INSERT INTO public.stock_ledger (
                wholesaler_id, product_id, inbound_scan_id, qty_delta,
                event_type, source_type, source_id, reason, created_by
            ) VALUES (
                v_order.wholesaler_id, v_item.product_id, NULL, -v_remaining,
                'ORDER_OUT', 'order', p_order_id, '이력 미추적 재고분', auth.uid()
            );
        END IF;

        PERFORM public.recalc_product_stock(v_item.product_id);
    END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_order_shipment(UUID) FROM PUBLIC;


-- --------------------------------------------------------------------
-- 주문 취소 시 원복. 나갔던 박스에 그대로 되돌린다(역분개).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_order_shipment(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row RECORD;
BEGIN
    -- 차감된 적이 없으면(예: 접수대기에서 바로 취소) 할 일이 없다.
    IF NOT EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_OUT'
    ) THEN
        RETURN;
    END IF;

    -- 이미 원복된 주문이면 건너뛴다.
    IF EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_RESTORE'
    ) THEN
        RETURN;
    END IF;

    -- 출고 스캔(record_outbound_scan)이 자동 배정을 되돌리고(OUTBOUND_UNASSIGN)
    -- 실제 집은 박스로 재배정(OUTBOUND_ASSIGN)했을 수 있으므로, 원래 확정 시
    -- 차감분(ORDER_OUT)만 보고 되돌리면 스캔으로 옮겨간 박스는 복원되지 않고
    -- 이미 스캔이 복원해 둔 박스는 중복 복원된다. 박스별 순 출고량을 되돌린다.
    FOR v_row IN
        SELECT wholesaler_id, product_id, inbound_scan_id, SUM(qty_delta) AS qty_delta
        FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id
          AND event_type IN ('ORDER_OUT', 'OUTBOUND_UNASSIGN', 'OUTBOUND_ASSIGN')
        GROUP BY wholesaler_id, product_id, inbound_scan_id
        HAVING SUM(qty_delta) <> 0
    LOOP
        IF v_row.inbound_scan_id IS NOT NULL THEN
            -- 취소된 박스가 그 사이 폐기(VOIDED)됐을 수 있다 — 그때는 박스 잔량을
            -- 되돌리지 않고 원장에만 남긴다(재고 수량은 아래 recalc로 맞춰진다).
            UPDATE public.inbound_scans
            SET remaining_weight = remaining_weight + (-v_row.qty_delta)
            WHERE id = v_row.inbound_scan_id AND status = 'NORMAL';
        END IF;

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) VALUES (
            v_row.wholesaler_id, v_row.product_id, v_row.inbound_scan_id, -v_row.qty_delta,
            'ORDER_RESTORE', 'order', p_order_id, '주문 취소 원복', auth.uid()
        );

        PERFORM public.recalc_product_stock(v_row.product_id);
    END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reverse_order_shipment(UUID) FROM PUBLIC;


-- --------------------------------------------------------------------
-- orders.status 변화를 재고에 반영하는 트리거 (설계 결정 2번).
-- BEFORE 트리거(enforce_order_cancel_authority)가 상태 전이 권한을 이미
-- 검증하므로 여기서는 재고만 다룬다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_order_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
        PERFORM public.apply_order_shipment(NEW.id);

    ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
        PERFORM public.reverse_order_shipment(NEW.id);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_stock_sync ON public.orders;
CREATE TRIGGER trg_orders_stock_sync
    AFTER UPDATE OF status ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.sync_order_stock();


-- --------------------------------------------------------------------
-- 거래명세서/주문 상세에 "이 주문에 나간 이력번호"를 붙이기 위한 조회 함수.
-- 박스 단위로 출고를 추적한 이유가 바로 이것이다 — 식당이 원산지 표시나
-- 위생 점검에서 요구받는 서류를 수기 장부 없이 뽑을 수 있게 된다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_trace_numbers(p_order_id UUID)
RETURNS TABLE (
    product_id     UUID,
    product_name   TEXT,
    trace_no       TEXT,
    quantity       NUMERIC,
    grade          TEXT,
    slaughter_date DATE,
    butchery_place TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        l.product_id,
        p.name,
        s.trace_no,
        -l.qty_delta,
        m.grade,
        m.slaughter_date,
        m.butchery_place
    FROM public.stock_ledger l
    JOIN public.orders o          ON o.id = l.source_id
    JOIN public.inbound_scans s   ON s.id = l.inbound_scan_id
    JOIN public.products p        ON p.id = l.product_id
    LEFT JOIN public.master_livestock m ON m.trace_no = s.trace_no
    WHERE l.source_type = 'order'
      AND l.source_id = p_order_id
      AND l.event_type = 'ORDER_OUT'
      AND l.inbound_scan_id IS NOT NULL
      -- 주문 당사자(공급사 owner/직원, 해당 바이어)와 관리자만 볼 수 있다.
      AND (
            o.wholesaler_id = public.get_current_wholesaler_id()
         OR public.is_org_staff_of_wholesaler(o.wholesaler_id)
         OR o.retailer_id = public.get_current_retailer_id()
         OR public.get_current_role() = 'super_admin'
      )
    ORDER BY p.name, s.trace_no;
$$;

REVOKE EXECUTE ON FUNCTION public.get_order_trace_numbers(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_order_trace_numbers(UUID) TO authenticated;
