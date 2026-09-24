-- ====================================================================
-- 공통 권한·격리 점검(2026-09-24, scripts/db-test-access-isolation.sql)에서 나온 구멍 5개
--
-- (1) 바이어 취소 요청이 DB에서 전부 막혀 있던 회귀
--     20260912000000이 orders UPDATE 정책을 "USING pending|confirmed + WITH CHECK
--     cancel_requested"로 고쳤는데, 20260930000024(직원 RLS)가 같은 정책을 초기
--     스키마 모양(USING status='pending', WITH CHECK 없음)으로 다시 만들었다.
--     WITH CHECK가 없으면 USING이 변경 후 행에도 적용되므로 status를 cancel_requested로
--     바꾸는 순간 정책 위반 — 접수대기 주문조차 취소 요청이 안 됐다(화면엔 버튼이 뜨고
--     누르면 "새로고침 후 다시 시도" 오류). 0912 모양 + 024의 직원 조건을 합쳐 복원한다.
--
-- (2) 공급사 사장이 자기 회사 wholesalers 행의 플랫폼 전용 컬럼(승인상태·구독상태·
--     무료체험 시작일·청구 시작일·국세청검증 상태·사업자번호·소유 계정)을 본인 세션으로
--     직접 UPDATE 할 수 있었다(RLS UPDATE 정책이 profile_id = auth.uid()뿐, 컬럼 보호
--     없음). 셀프 승인·구독료 회피·국세청 검증 우회 경로. profiles.role 불변 트리거와
--     같은 방식의 컬럼 보호 트리거를 단다.
--     - SECURITY INVOKER로 만들어 current_user로 호출 주체를 본다: PostgREST 직접 호출은
--       authenticated/anon, 서비스 키·크론·SECURITY DEFINER RPC(온보딩·국세청 기록) 내부는
--       postgres/service_role이라 그대로 통과. super_admin 세션은 역할로 통과.
--
-- (3) 트리거 내부용 재고 함수 4개(apply/reverse_order_shipment, recalc_product_stock,
--     release_hot_deal_quota)에 Supabase 기본 GRANT(anon·authenticated EXECUTE)가 남아
--     주문 ID만 알면 비로그인으로도 남의 재고를 차감·원복할 수 있었다. 호출자는 전부
--     SECURITY DEFINER(sync_order_stock 트리거, 출고/세트/조정 RPC)라 회수해도 영향 없다.
--     앱 코드가 직접 부르는 곳 없음(grep 확인).
--
-- (4) reserve_hot_deal_quota에 소유·상태 검사와 중복 방지가 없어 바이어가 자기 주문 ID로
--     반복 호출하면 핫딜 판매량이 계속 올라갔다(남들 핫딜 매진시키기). 주문 소유자
--     (또는 service_role — 재대조 크론 경로)만, 접수대기 상태에서만, 주문당 1회만
--     소진되게 한다. 1회 보장은 orders 컬럼이 아니라 별도 예약 테이블 PK로 한다 —
--     orders를 바이어 세션에서 UPDATE 하면 enforce_order_cancel_authority가
--     "취소 요청만 가능"으로 막기 때문이다.
--
-- (5) apply_credit_order가 음수 금액을 받아 바이어가 자기 미수금을 0으로 만들 수 있었다.
--
-- 로컬 검증: scripts/db-test-access-isolation.sql
-- ====================================================================

-- --------------------------------------------------------------------
-- (1) orders UPDATE 정책 복원
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Orders updatable by wholesaler org staff (status) or retailer (cancel)" ON public.orders;

CREATE POLICY "Orders updatable by wholesaler org staff (status) or retailer (cancel)" ON public.orders
    FOR UPDATE
    USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR (
            retailer_id = public.get_current_retailer_id()
            AND status IN ('pending', 'confirmed')
            AND EXISTS (
                SELECT 1
                FROM public.wholesaler_retailers wr
                WHERE wr.wholesaler_id = orders.wholesaler_id
                  AND wr.retailer_id = public.get_current_retailer_id()
                  AND wr.status = 'active'
            )
        )
    )
    WITH CHECK (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR (
            retailer_id = public.get_current_retailer_id()
            AND status = 'cancel_requested'
            AND EXISTS (
                SELECT 1
                FROM public.wholesaler_retailers wr
                WHERE wr.wholesaler_id = orders.wholesaler_id
                  AND wr.retailer_id = public.get_current_retailer_id()
                  AND wr.status = 'active'
            )
        )
    );

-- --------------------------------------------------------------------
-- (2) wholesalers 플랫폼 전용 컬럼 보호
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_wholesaler_platform_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 서비스 키·크론·SECURITY DEFINER RPC 내부(postgres/service_role)는 통과.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF public.get_current_role() = 'super_admin' THEN
        RETURN NEW;
    END IF;

    IF NEW.status                  IS DISTINCT FROM OLD.status
       OR NEW.subscription_status     IS DISTINCT FROM OLD.subscription_status
       OR NEW.trial_started_at        IS DISTINCT FROM OLD.trial_started_at
       OR NEW.billing_starts_at       IS DISTINCT FROM OLD.billing_starts_at
       OR NEW.nts_verification_status IS DISTINCT FROM OLD.nts_verification_status
       OR NEW.nts_verified_at         IS DISTINCT FROM OLD.nts_verified_at
       OR NEW.business_number         IS DISTINCT FROM OLD.business_number
       OR NEW.business_start_date     IS DISTINCT FROM OLD.business_start_date
       OR NEW.profile_id              IS DISTINCT FROM OLD.profile_id
    THEN
        RAISE EXCEPTION 'PLATFORM_ONLY_COLUMN';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wholesalers_platform_columns ON public.wholesalers;
CREATE TRIGGER trg_wholesalers_platform_columns
    BEFORE UPDATE ON public.wholesalers
    FOR EACH ROW EXECUTE FUNCTION public.enforce_wholesaler_platform_columns();

COMMENT ON FUNCTION public.enforce_wholesaler_platform_columns() IS
    '승인·구독·국세청검증·사업자번호·소유계정 컬럼은 super_admin 세션 또는 서버(service_role/RPC 내부)만 바꿀 수 있다. 공급사 본인 세션의 직접 UPDATE는 PLATFORM_ONLY_COLUMN으로 거부.';

-- --------------------------------------------------------------------
-- (3) 트리거 내부용 재고 함수 실행 권한 회수
-- --------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.apply_order_shipment(uuid)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_order_shipment(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalc_product_stock(uuid)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_hot_deal_quota(uuid) FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------------------
-- (4) reserve_hot_deal_quota — 소유·상태 검사 + 주문당 1회
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hot_deal_quota_reservations (
    order_id    UUID PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.hot_deal_quota_reservations ENABLE ROW LEVEL SECURITY;
-- 정책 없음: reserve_hot_deal_quota(SECURITY DEFINER) 내부에서만 읽고 쓴다.
REVOKE ALL ON public.hot_deal_quota_reservations FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.hot_deal_quota_reservations IS
    '핫딜 한도가 이미 소진된 주문. reserve_hot_deal_quota가 주문당 한 번만 판매량을 올리게 하는 잠금 — 주문이 지워지면 같이 지워진다.';

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
    -- NULL-safe: get_current_retailer_id()가 NULL(공급사·비로그인)이면 IS NOT TRUE로 거부.
    IF auth.role() IS DISTINCT FROM 'service_role'
       AND (v_order.retailer_id = public.get_current_retailer_id()) IS NOT TRUE THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status <> 'pending' THEN
        RAISE EXCEPTION 'ORDER_NOT_PENDING:%', v_order.status;
    END IF;

    -- 주문당 1회. 같은 주문으로 두 번 부르면 PK 충돌 — 동시 호출도 두 번째가 여기서 멈춘다.
    BEGIN
        INSERT INTO public.hot_deal_quota_reservations (order_id) VALUES (p_order_id);
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'HOT_DEAL_ALREADY_RESERVED';
    END;

    FOR v_hot IN
        SELECT product_id, SUM(quantity) AS quantity
        FROM public.order_items
        WHERE order_id = p_order_id AND is_hot_deal
        GROUP BY product_id
        -- product_id 오름차순으로 고정해 동시 결제 간 잠금 순서를 일치시킨다
        -- (apply_order_shipment의 inbound_scans ORDER BY created_at과 같은 이유의
        -- 데드락 방지 — GROUP BY만으로는 해시 순서가 백엔드마다 달라질 수 있다).
        ORDER BY product_id
    LOOP
        -- 상품 행을 잠가 동시 결제가 순서대로 처리되게 한다(재고 FOR UPDATE와 같은 원리).
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

REVOKE EXECUTE ON FUNCTION public.reserve_hot_deal_quota(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.reserve_hot_deal_quota(UUID) TO authenticated, service_role;

-- --------------------------------------------------------------------
-- (5) apply_credit_order — 0 이하 금액 거부
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_credit_order(p_wholesaler_retailer_id UUID, p_amount NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_new_balance NUMERIC;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'INVALID_AMOUNT';
    END IF;

    UPDATE public.wholesaler_retailers
    SET outstanding_balance = outstanding_balance + p_amount
    WHERE id = p_wholesaler_retailer_id
      AND retailer_id = public.get_current_retailer_id()
      AND outstanding_balance + p_amount <= credit_limit
    RETURNING outstanding_balance INTO v_new_balance;

    IF v_new_balance IS NULL THEN
        RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED';
    END IF;

    RETURN v_new_balance;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_credit_order(UUID, NUMERIC) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.apply_credit_order(UUID, NUMERIC) TO authenticated;
