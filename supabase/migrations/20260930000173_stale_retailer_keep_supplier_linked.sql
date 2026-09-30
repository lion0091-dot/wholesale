-- 173: 동의 안 한 미완료 고객 자동삭제(166)에서, 공급사가 이미 승인·차단해 둔 거래 연결이 있는 고객은 제외한다.
--
-- retailers 행을 지우면 wholesaler_retailers가 ON DELETE CASCADE로 함께 사라져, 공급사가 설정해 둔 거래처 별칭·
-- 외상 한도·거래 상태가 고객 몫으로 지워질 수 있었다(초대로 들어온 고객은 retailer_invites 조건으로 이미 제외됨).
-- 초대 없이 매장 코드로 들어와 승인 대기(pending_review)인 연결은 이전처럼 삭제 대상이다.
-- delete_stale_retailer_rows는 이 조회로 대상을 재검증하므로 본문 변경이 필요 없다.

CREATE OR REPLACE FUNCTION public.list_stale_unconsented_retail_accounts()
RETURNS TABLE (user_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
    SELECT p.id
      FROM public.profiles p
      JOIN auth.users u ON u.id = p.id
      JOIN public.retailers r ON r.profile_id = p.id
     WHERE p.terms_agreed_at IS NULL
       AND p.privacy_agreed_at IS NULL
       AND p.withdrawn_at IS NULL
       AND p.role::text <> 'super_admin'
       AND COALESCE(u.last_sign_in_at, u.created_at) < now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM public.wholesalers w WHERE w.profile_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.organization_staff s WHERE s.user_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.platform_admin_allowlist a WHERE a.user_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.retailer_invites i WHERE i.created_by = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.retailer_invites i WHERE i.consumed_retailer_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.wholesaler_retailers wr WHERE wr.retailer_id = r.id AND wr.status <> 'pending_review')
       AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.retailer_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.custom_prices c WHERE c.retailer_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.pg_pending_payments g WHERE g.retailer_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.outbound_sms_queue q WHERE q.retailer_id = r.id);
$$;

REVOKE ALL ON FUNCTION public.list_stale_unconsented_retail_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_stale_unconsented_retail_accounts() TO service_role;
