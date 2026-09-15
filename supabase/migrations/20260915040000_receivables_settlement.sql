-- ====================================================================
-- 미수금 정산 (ROADMAP Post-MVP #6, 체크리스트 3,4)
-- 정산 주기는 거래처별 고정 N일(연체 기준)로 단순화한다 (요일/월 마감일 계산 없음).
-- ====================================================================

-- wholesaler_retailers: 거래처별 연체 기준일 (ordered_at + settlement_due_days 경과 시 연체 표시)
ALTER TABLE public.wholesaler_retailers
    ADD COLUMN settlement_due_days INTEGER NOT NULL DEFAULT 30 CHECK (settlement_due_days > 0);

-- orders: 외상 주문 정산 완료 시각 (NULL이면 미정산)
ALTER TABLE public.orders
    ADD COLUMN settled_at TIMESTAMPTZ;

-- 외상 주문 정산 처리 RPC.
-- 선택한 주문 중 (내 소유 + 외상 + 미정산) 조건을 만족하는 것만 정산완료 처리하고,
-- 실제로 이번 호출에서 새로 정산된 금액만 거래처별로 합산해 미수금 잔액에서 차감한다
-- (이미 정산된 주문이 섞여 들어와도 중복 차감되지 않는다).
CREATE OR REPLACE FUNCTION public.settle_credit_orders(p_order_ids UUID[])
RETURNS TABLE(retailer_id UUID, new_outstanding_balance NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID := public.get_current_wholesaler_id();
BEGIN
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_WHOLESALER';
    END IF;

    RETURN QUERY
    WITH just_settled AS (
        UPDATE public.orders
        SET settled_at = now()
        WHERE id = ANY(p_order_ids)
          AND wholesaler_id = v_wholesaler_id
          AND payment_method = 'on_credit'
          AND settled_at IS NULL
        RETURNING orders.retailer_id AS r_id, orders.total_amount AS amount
    ),
    grouped AS (
        SELECT r_id, SUM(amount) AS amount FROM just_settled GROUP BY r_id
    ),
    updated AS (
        UPDATE public.wholesaler_retailers wr
        SET outstanding_balance = GREATEST(wr.outstanding_balance - grouped.amount, 0)
        FROM grouped
        WHERE wr.wholesaler_id = v_wholesaler_id
          AND wr.retailer_id = grouped.r_id
        RETURNING wr.retailer_id, wr.outstanding_balance
    )
    SELECT updated.retailer_id, updated.outstanding_balance FROM updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.settle_credit_orders(UUID[]) TO authenticated;
