-- 4번 출고·주문 DB 테스트(scripts/db-test-orders-outbound.sql)에서 나온 관찰 2건 — 사장님 결정(2026-09-24)으로 DB에서도 막는다.
--
-- 1) 주문 상태 전이 규칙을 DB로.
--    lib/orders/status.ts 의 ORDER_STATUS_TRANSITIONS 는 대시보드 서버 액션만 검사했다. 공급사 세션이
--    테이블을 직접 UPDATE 하면 배송완료→접수대기 되돌리기, 출고 확정된 배송중→취소가 통과했고,
--    취소→재확정은 원장 멱등 인덱스(idx_stock_ledger_idempotent)에 우연히 걸릴 때만 실패했다
--    (다른 박스가 뽑히면 재고가 다시 빠진다). 표를 그대로 옮겨 어느 경로로 와도 같은 규칙을 탄다.
--    기존 enforce_order_cancel_authority(바이어는 취소요청만, 취소요청은 승인/반려로만 종결)는 그대로 두고
--    그 위에 얹는다. 서버(service_role)·SECURITY DEFINER RPC 내부·super_admin 세션은 통과 — finalize_order_shipment
--    (확정→배송중), 입고 즉시 배정, 크론, 관리자 정리 작업이 막히지 않게.
--
-- 2) 최소발주금액을 DB로.
--    서버 액션 두 경로(submitOrderAction, PG 체크아웃)만 validateCart 로 wholesalers.min_order_amount 를
--    검사했다. 바이어 세션의 직접 INSERT 는 미달 주문도 들어갔다. 헤더 INSERT 에서 총액을 대조한다.
--    (품목 소계 합 ≤ 총액은 103 트리거가 이미 보장하므로 총액만 보면 된다.)
--
-- 앱 표(lib/orders/status.ts)와 이 함수는 항상 같이 고친다.

CREATE OR REPLACE FUNCTION public.enforce_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_allowed TEXT[];
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    -- 서비스 키·크론·SECURITY DEFINER RPC 내부(postgres/service_role)는 통과.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF public.get_current_role() = 'super_admin' THEN
        RETURN NEW;
    END IF;

    v_allowed := CASE OLD.status
        WHEN 'pending'          THEN ARRAY['awaiting_stock', 'confirmed', 'cancel_requested', 'cancelled']
        WHEN 'awaiting_stock'   THEN ARRAY['confirmed', 'cancel_requested', 'cancelled']
        WHEN 'confirmed'        THEN ARRAY['shipping', 'cancel_requested', 'cancelled']
        WHEN 'shipping'         THEN ARRAY['delivered']
        WHEN 'delivered'        THEN ARRAY[]::TEXT[]
        WHEN 'cancel_requested' THEN ARRAY['cancelled', 'cancel_rejected']
        WHEN 'cancel_rejected'  THEN ARRAY['awaiting_stock', 'confirmed', 'shipping', 'cancelled']
        WHEN 'cancelled'        THEN ARRAY[]::TEXT[]
        ELSE ARRAY[]::TEXT[]
    END;

    IF NOT (NEW.status = ANY (v_allowed)) THEN
        RAISE EXCEPTION 'INVALID_STATUS_TRANSITION:%:%', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_order_status_transition() IS
    'lib/orders/status.ts ORDER_STATUS_TRANSITIONS 와 같은 표. 둘은 항상 같이 고친다(20260930000107). 서버·RPC 내부·super_admin은 통과.';

DROP TRIGGER IF EXISTS trg_orders_status_transition ON public.orders;
CREATE TRIGGER trg_orders_status_transition
    BEFORE UPDATE OF status ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.enforce_order_status_transition();


CREATE OR REPLACE FUNCTION public.enforce_min_order_amount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_min NUMERIC;
BEGIN
    -- 바이어(또는 비로그인) 세션의 직접 INSERT만 대조한다. 서버 경로는 validateCart를 이미 거쳤다.
    IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(min_order_amount, 0) INTO v_min
    FROM public.wholesalers WHERE id = NEW.wholesaler_id;

    IF v_min > 0 AND COALESCE(NEW.total_amount, 0) < v_min THEN
        RAISE EXCEPTION 'MIN_ORDER_AMOUNT:%:%', v_min, COALESCE(NEW.total_amount, 0);
    END IF;

    RETURN NEW;
END;
$$;

-- 트리거 내부용 SECURITY DEFINER — 직접 호출 못 하게 EXECUTE 회수(102 원칙).
REVOKE EXECUTE ON FUNCTION public.enforce_min_order_amount() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_min_order_amount() IS
    '바이어 세션의 주문 헤더 INSERT에서 총액 < wholesalers.min_order_amount 거부. 서버 액션의 validateCart와 같은 기준(20260930000107).';

DROP TRIGGER IF EXISTS trg_orders_min_order_amount ON public.orders;
CREATE TRIGGER trg_orders_min_order_amount
    BEFORE INSERT ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.enforce_min_order_amount();
