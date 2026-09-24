-- 112. 정지·해지·거절된 공급사의 DB 직접 쓰기 차단 (8번 관리자 점검, 사장님 결정 2026-09-24)
--
-- 발견: 앱 화면은 status ≠ 'active' 공급사를 막지만, DB는 정지(suspended)·해지(closed)·거절(rejected) 상태의
--   공급사 사장/매니저가 API를 직접 호출해 상품을 수정·등록·삭제할 수 있었고, 거래처도 그 공급사에 주문을 만들 수 있었다.
-- 결정: 세 상태만 DB에서도 막는다. 승인 대기(pending)는 기존 결정대로 상품 등록을 허용한다.
--   구독 미납·체험 만료(overdue/cancelled)는 화면 잠금만 유지한다(기간 경계와 겹치므로 DB 차단 안 함).
--
-- 범위: 세션(authenticated/anon) 직접 쓰기만. 서버 키(service_role)·SECURITY DEFINER RPC 내부·크론은 통과하므로
--   재고 재계산, 주문 확정/취소에 따른 재고 차감, PG 결제 복구 크론은 영향이 없다. 슈퍼관리자 세션도 통과.
-- 이미 만들어진 주문의 상태 변경(확정/배송/취소 처리)은 이번 범위가 아니다.

-- 1) 상품: 정지·해지·거절 공급사의 세션 쓰기 차단 (SECURITY INVOKER — 102와 같은 current_user 판별)
CREATE OR REPLACE FUNCTION public.enforce_active_supplier_products()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.wholesaler_id ELSE NEW.wholesaler_id END;
    v_status TEXT;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    IF public.get_current_role() = 'super_admin' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    SELECT w.status INTO v_status FROM public.wholesalers w WHERE w.id = v_wholesaler_id;

    IF v_status IN ('suspended', 'closed', 'rejected') THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_ACTIVE:%', v_status;
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS trg_products_active_supplier ON public.products;
CREATE TRIGGER trg_products_active_supplier
    BEFORE INSERT OR UPDATE OR DELETE ON public.products
    FOR EACH ROW EXECUTE FUNCTION public.enforce_active_supplier_products();

-- 2) 주문: 거래처(바이어) 세션의 신규 주문 INSERT 차단 (107의 최소주문금액 트리거와 같은 auth.role() 판별)
CREATE OR REPLACE FUNCTION public.enforce_active_supplier_orders()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_status TEXT;
BEGIN
    IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    SELECT w.status INTO v_status FROM public.wholesalers w WHERE w.id = NEW.wholesaler_id;

    IF v_status IN ('suspended', 'closed', 'rejected') THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_ACTIVE:%', v_status;
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.enforce_active_supplier_orders() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_active_supplier ON public.orders;
CREATE TRIGGER trg_orders_active_supplier
    BEFORE INSERT ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.enforce_active_supplier_orders();
