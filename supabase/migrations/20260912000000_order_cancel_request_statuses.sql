-- ====================================================================
-- 주문 상태 확장: 취소 요청(cancel_requested) / 취소 반려(cancel_rejected)
--
-- 플로우:
--   pending | confirmed --(바이어)--> cancel_requested
--   cancel_requested --(공급사 승인)--> cancelled
--   cancel_requested --(공급사 반려)--> cancel_rejected --> confirmed | shipping
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

-- 4. RLS: 바이어는 pending/confirmed 상태에서 취소 요청을 넣을 수 있어야 한다.
--    (기존 정책은 retailer에게 status = 'pending' 일 때만 UPDATE를 허용)
DROP POLICY IF EXISTS "Orders updatable by wholesaler (status) or retailer (cancel)" ON public.orders;

CREATE POLICY "Orders updatable by wholesaler (status) or retailer (cancel)" ON public.orders
    FOR UPDATE USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR (
            retailer_id = public.get_current_retailer_id()
            AND status IN ('pending', 'confirmed')
        )
    );

-- 5. 바이어는 취소 '요청'까지만 가능하고, 취소 확정/반려는 공급사만 수행한다.
CREATE OR REPLACE FUNCTION public.enforce_order_cancel_authority()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    -- 바이어(요청자) 측 변경 허용 범위
    IF OLD.retailer_id = public.get_current_retailer_id()
       AND OLD.wholesaler_id <> COALESCE(public.get_current_wholesaler_id(), '00000000-0000-0000-0000-000000000000'::uuid)
    THEN
        IF NEW.status <> 'cancel_requested' THEN
            RAISE EXCEPTION '바이어는 주문 취소 요청만 생성할 수 있습니다.';
        END IF;

        NEW.cancel_requested_at := now();
    END IF;

    -- 공급사가 취소 요청을 종결하는 시점 기록
    IF OLD.status = 'cancel_requested' AND NEW.status IN ('cancelled', 'cancel_rejected') THEN
        NEW.cancel_resolved_at := now();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_cancel_authority ON public.orders;

CREATE TRIGGER trg_orders_cancel_authority
    BEFORE UPDATE OF status ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.enforce_order_cancel_authority();
