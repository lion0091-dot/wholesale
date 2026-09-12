-- ====================================================================
-- 주문 상태 확장: 취소 요청(cancel_requested) / 취소 반려(cancel_rejected)
--
-- 플로우:
--   pending | confirmed --(바이어)--> cancel_requested
--   cancel_requested --(공급사 승인)--> cancelled
--   cancel_requested --(공급사 반려)--> cancel_rejected --> confirmed | shipping
--
-- 인증 구조 전제 (중요):
--   미니샵(/shop/<shop_token>)의 바이어는 ① HMAC 서명된 shop_token 세션 쿠키로
--   "어느 공급사의 미니샵에 들어왔는지"를 바인딩하고, ② 실제 거래처(retailer) 식별은
--   Supabase 로그인 세션(auth.uid())에 의존한다. 즉 취소 요청을 넣는 주체는
--   항상 인증된 사용자이므로 RLS는 auth.uid() 기반 헬퍼로 정상 동작하며,
--   service_role 키나 RLS 우회 경로가 필요하지 않다.
--   (쿠키 ↔ 로그인 계정 ↔ 거래 관계 일치 검증은 서버 액션이 수행한다:
--    app/shop/[shop_token]/actions.ts 의 verifyCancelRequester)
--
-- 이 마이그레이션은 전체가 멱등(idempotent)하므로 재실행해도 안전하다.
-- ====================================================================

-- 1. status CHECK 제약 교체
ALTER TABLE public.orders
    DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
    ADD CONSTRAINT orders_status_check CHECK (
        status IN (
            'pending',
            'confirmed',
            'shipping',
            'delivered',
            'cancel_requested',
            'cancel_rejected',
            'cancelled'
        )
    );

-- 2. 취소 요청 메타데이터 (요청 사유 / 요청·처리 시각)
ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
    ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancel_resolved_at TIMESTAMPTZ;

-- 3. 취소 요청 대기 건을 공급사 대시보드에서 빠르게 조회
CREATE INDEX IF NOT EXISTS idx_orders_cancel_requested
    ON public.orders(wholesaler_id, cancel_requested_at DESC)
    WHERE status = 'cancel_requested';

-- ====================================================================
-- 4. RLS: 발주서 UPDATE 권한
--
--    기존 정책의 문제:
--      - 바이어 분기가 status = 'pending' 에만 걸려 있어 '확정(confirmed)' 발주의
--        취소 요청이 불가능했다.
--      - WITH CHECK 절이 없어 USING을 통과한 바이어가 금액(total_amount)·배송지·
--        상태를 임의 값으로 덮어쓸 수 있었다. (UPDATE 정책에 WITH CHECK를 생략하면
--        USING이 그대로 재사용되는데, USING은 '변경 전' 행만 검사한다.)
--      - 거래 관계가 해지(inactive)된 거래처도 과거 발주서를 계속 수정할 수 있었다.
--
--    정비 방향:
--      USING       = 변경 '전' 행이 pending/confirmed 이고 활성 거래 관계일 때만 진입
--      WITH CHECK  = 변경 '후' 행의 status가 정확히 cancel_requested 여야 통과
--      → 두 절의 교집합으로 "바이어는 pending|confirmed → cancel_requested 전이
--        단 하나만 수행할 수 있다"가 RLS 레벨에서 강제된다.
-- ====================================================================
DROP POLICY IF EXISTS "Orders updatable by wholesaler (status) or retailer (cancel)" ON public.orders;

CREATE POLICY "Orders updatable by wholesaler (status) or retailer (cancel)" ON public.orders
    FOR UPDATE
    USING (
        wholesaler_id = public.get_current_wholesaler_id()
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
        -- 공급사도 자신의 발주서를 타 공급사로 이전할 수는 없다.
        wholesaler_id = public.get_current_wholesaler_id()
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

-- 로그인한 바이어/공급사가 RLS 정책 판정을 받을 수 있도록 테이블 권한을 명시한다.
-- (권한이 없으면 정책과 무관하게 permission denied 가 되고, 반대로 권한만 있고
--  정책에 걸리면 0건 UPDATE로 조용히 실패하므로 서버 액션에서 영향 행 수를 검사한다.)
GRANT SELECT, INSERT, UPDATE ON public.orders TO authenticated;
GRANT SELECT, INSERT ON public.order_items TO authenticated;

-- ====================================================================
-- 5. 바이어는 취소 '요청'까지만 가능하고, 취소 확정/반려는 공급사만 수행한다.
--
--    RLS(4번)와 중복되는 방어선이지만, RLS를 우회하는 경로(테이블 소유자,
--    service_role, SECURITY DEFINER 함수, 시드 스크립트)에서도 상태 전이 규칙과
--    금액 불변성이 지켜지도록 트리거로 한 번 더 고정한다.
--
--    변경점:
--      - BEFORE UPDATE OF status → BEFORE UPDATE (전체 컬럼).
--        status를 건드리지 않는 UPDATE로 금액·배송지를 바꾸는 우회를 막는다.
--      - 기존 바이어 판정식
--          OLD.wholesaler_id <> COALESCE(get_current_wholesaler_id(), '000...'::uuid)
--        은 로그인하지 않은 호출자(두 헬퍼 모두 NULL)에서 참이 되어 의미가 없었다.
--        → "현재 계정이 이 발주서의 거래처이고, 공급사 본인은 아니다"로 명확화.
--      - SECURITY DEFINER 함수의 search_path 고정 (search_path 하이재킹 방어).
-- ====================================================================
CREATE OR REPLACE FUNCTION public.enforce_order_cancel_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID := public.get_current_wholesaler_id();
    v_retailer_id   UUID := public.get_current_retailer_id();
    v_is_owner      BOOLEAN;
    v_is_buyer      BOOLEAN;
BEGIN
    v_is_owner := v_wholesaler_id IS NOT NULL AND v_wholesaler_id = OLD.wholesaler_id;
    v_is_buyer := v_retailer_id IS NOT NULL AND v_retailer_id = OLD.retailer_id;

    -- (A) 바이어(구매 회원) 경로: '취소 요청' 전이 하나만 허용
    IF v_is_buyer AND NOT v_is_owner THEN
        IF OLD.status NOT IN ('pending', 'confirmed') OR NEW.status <> 'cancel_requested' THEN
            RAISE EXCEPTION '바이어는 접수대기/확정 상태의 발주서에 대해 취소 요청만 생성할 수 있습니다.';
        END IF;

        -- 취소 요청과 무관한 컬럼은 원본 값으로 되돌린다 (금액·배송지 위조 차단).
        NEW.id                  := OLD.id;
        NEW.wholesaler_id       := OLD.wholesaler_id;
        NEW.retailer_id         := OLD.retailer_id;
        NEW.order_number        := OLD.order_number;
        NEW.total_amount        := OLD.total_amount;
        NEW.delivery_address    := OLD.delivery_address;
        NEW.delivery_notes      := OLD.delivery_notes;
        NEW.ordered_at          := OLD.ordered_at;
        NEW.cancel_resolved_at  := OLD.cancel_resolved_at;

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

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_cancel_authority ON public.orders;

CREATE TRIGGER trg_orders_cancel_authority
    BEFORE UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.enforce_order_cancel_authority();
