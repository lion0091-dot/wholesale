-- ====================================================================
-- 외상거래(여신) 관리: 주문 시 잔액 증감 RPC (ROADMAP Post-MVP #6, 체크리스트 2)
-- 한도 초과 시 주문 자체를 차단한다 (원자적 UPDATE 조건으로 레이스 컨디션 방지).
-- ====================================================================
CREATE OR REPLACE FUNCTION public.apply_credit_order(
    p_wholesaler_retailer_id UUID,
    p_amount NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_new_balance NUMERIC;
BEGIN
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

GRANT EXECUTE ON FUNCTION public.apply_credit_order(UUID, NUMERIC) TO authenticated;
