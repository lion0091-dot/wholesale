-- settle_credit_orders()도 get_current_wholesaler_id()(원 가입자 본인)로만 wholesaler_id를
-- 찾아서, 조직 직원(owner/manager)은 앱 레벨 권한은 통과해도 여기서 NOT_A_WHOLESALER로
-- 막혔다. owner/manager 직원도 정산할 수 있도록 조회를 확장한다.
CREATE OR REPLACE FUNCTION public.settle_credit_orders(p_order_ids UUID[])
RETURNS TABLE(retailer_id UUID, new_outstanding_balance NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID := COALESCE(
        public.get_current_wholesaler_id(),
        (
            SELECT o.wholesaler_id
              FROM public.organization_staff s
              JOIN public.organizations o ON o.id = s.organization_id
             WHERE s.user_id = auth.uid()
               AND s.role = ANY(ARRAY['owner', 'manager']::public.organization_role[])
             LIMIT 1
        )
    );
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
