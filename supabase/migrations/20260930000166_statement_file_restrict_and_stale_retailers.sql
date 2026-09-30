-- 166: (1) 명세서 파일 행의 업체 FK를 CASCADE → RESTRICT (2) 가입 미완료 "고객(소매)" 계정 자동 정리 대상 조회·삭제
-- (2026-09-30, 사장님 결정: 165의 소매 확장 + 보관의무 반영)
--
-- (1) supplier_statement_files.wholesaler_id
--     업체 행이 직접 지워질 때 매입 명세서 파일 행이 같이 사라지면 보관 취지(삭제 불가)가 무너진다.
--     탈퇴 경로는 wholesalers 행을 지우지 않으므로(익명화) 지금 동작은 바뀌지 않는다. 지우려 하면 막힌다.
--
-- (2) 소매 미완료 계정
--     claim_shop_access가 로그인 즉시 retailers·wholesaler_retailers를 만들어 165 조건에서 제외됐다.
--     거래 흔적이 전혀 없을 때만 대상으로 잡는다:
--       동의 없음 + 30일 경과 + 주문 0건 + 맞춤단가·PG 결제대기·문자 큐 없음
--       + 초대장 사용(consumed) 기록 없음 + 업체/직원/관리자/초대발부 연결 없음
--     삭제는 retailers 행을 먼저 지운 뒤(자동 생성된 wholesaler_retailers 등은 CASCADE) 크론이
--     Auth Admin API로 auth.users를 지운다. orders.retailer_id는 RESTRICT라 이중 안전장치가 된다.
--     함수들은 service_role 전용.

ALTER TABLE public.supplier_statement_files
    DROP CONSTRAINT IF EXISTS supplier_statement_files_wholesaler_id_fkey;
ALTER TABLE public.supplier_statement_files
    ADD CONSTRAINT supplier_statement_files_wholesaler_id_fkey
    FOREIGN KEY (wholesaler_id) REFERENCES public.wholesalers(id) ON DELETE RESTRICT;

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
       AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.retailer_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.custom_prices c WHERE c.retailer_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.pg_pending_payments g WHERE g.retailer_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.outbound_sms_queue q WHERE q.retailer_id = r.id);
$$;

-- 대상 재검증 후 retailers 행 삭제. 조건이 조회 이후 바뀌었으면 0을 돌려주고 아무것도 지우지 않는다.
CREATE OR REPLACE FUNCTION public.delete_stale_retailer_rows(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.list_stale_unconsented_retail_accounts() s WHERE s.user_id = p_user_id
    ) THEN
        RETURN 0;
    END IF;

    DELETE FROM public.retailers WHERE profile_id = p_user_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.list_stale_unconsented_retail_accounts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_stale_retailer_rows(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_stale_unconsented_retail_accounts() TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_stale_retailer_rows(UUID) TO service_role;

COMMENT ON FUNCTION public.list_stale_unconsented_retail_accounts() IS
    '동의 없이 30일 넘게 이탈한 고객(소매) 계정 중 거래 흔적이 전혀 없는 것. service_role 전용.';
COMMENT ON FUNCTION public.delete_stale_retailer_rows(UUID) IS
    '대상 재검증 후 해당 계정의 retailers 행 삭제(연결된 자동 생성 행은 CASCADE). service_role 전용.';
