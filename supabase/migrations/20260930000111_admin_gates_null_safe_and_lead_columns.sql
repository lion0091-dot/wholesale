-- 111. 관리자 기능 점검(8번) 수정: scripts/db-test-admin.sql
--
-- ① cancel_platform_event(및 set_supplier_verification, set_nts_verification_result)의 권한 검사가
--    `get_current_role() <> 'super_admin'` 이라, 비로그인(또는 profiles 행이 없는 계정)은 role이 NULL이라
--    조건이 NULL이 되어 검사를 그대로 통과했다(097과 같은 plpgsql NULL 비교 버그).
--    테스트에서 anon이 진행 중인 플랫폼 이벤트를 실제로 취소했다. IS DISTINCT FROM으로 고치고 anon 실행 권한도 회수한다.
-- ② 비로그인 입점 희망 리드 제출이 관리자 전용 컬럼(status, admin_note)을 직접 채울 수 있었다 → 정책으로 고정.
-- ③ 이미 승인된 공급사를 재승인하면 최초 승인자·승인시각이 덮어써졌다 → 이미 승인된 계정은 기존 값 유지.
-- ④ 구독 청구서 paid_amount에 0·음수를 넣을 수 있었다 → CHECK(신규 쓰기만 강제, 기존 행은 검증 안 함).
--
-- 함수 본문은 로컬 DB의 pg_get_functiondef 기준으로 필요한 줄만 바꿨다.

-- ① + ③
CREATE OR REPLACE FUNCTION public.cancel_platform_event(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
    if auth.uid() is null or public.get_current_role() is distinct from 'super_admin' then
        raise exception 'PLATFORM_ADMIN_ONLY';
    end if;

    update public.platform_events
       set status = 'cancelled',
           cancelled_by = auth.uid(),
           cancelled_at = now()
     where id = p_event_id
       and status = 'active';

    if not found then
        raise exception 'EVENT_NOT_FOUND_OR_ALREADY_CANCELLED';
    end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_nts_verification_result(p_wholesaler_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF auth.uid() IS NULL OR public.get_current_role() IS DISTINCT FROM 'super_admin' THEN
        RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
    END IF;

    IF p_status NOT IN ('match', 'mismatch', 'not_found', 'error') THEN
        RAISE EXCEPTION 'INVALID_NTS_STATUS';
    END IF;

    UPDATE public.wholesalers
       SET nts_verification_status = p_status,
           nts_verified_at = now(),
           updated_at = now()
     WHERE id = p_wholesaler_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
    END IF;

    RETURN jsonb_build_object('wholesaler_id', p_wholesaler_id, 'nts_verification_status', p_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_supplier_verification(p_wholesaler_id uuid, p_verified boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_actor   UUID := auth.uid();
    v_updated INT;
BEGIN
    IF v_actor IS NULL OR public.get_current_role() IS DISTINCT FROM 'super_admin' THEN
        RAISE EXCEPTION 'SUPER_ADMIN_REQUIRED';
    END IF;

    PERFORM set_config('app.supplier_onboarding', 'on', true);

    WITH targets AS (
        SELECT w.profile_id AS user_id
          FROM public.wholesalers w
         WHERE w.id = p_wholesaler_id
        UNION
        SELECT s.user_id
          FROM public.organization_staff s
          JOIN public.organizations o ON o.id = s.organization_id
         WHERE o.wholesaler_id = p_wholesaler_id
    )
    UPDATE public.profiles p
       SET is_verified = p_verified,
           -- 이미 승인된 계정을 재승인해도 최초 승인시각·승인자를 유지한다.
           verified_at = CASE
               WHEN NOT p_verified THEN NULL
               WHEN p.is_verified THEN COALESCE(p.verified_at, now())
               ELSE now()
           END,
           verified_by = CASE
               WHEN NOT p_verified THEN NULL
               WHEN p.is_verified THEN COALESCE(p.verified_by, v_actor)
               ELSE v_actor
           END,
           updated_at = now()
     WHERE p.id IN (SELECT user_id FROM targets)
       AND p.role <> 'super_admin';

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    PERFORM set_config('app.supplier_onboarding', 'off', true);

    RETURN jsonb_build_object('updated', v_updated, 'is_verified', p_verified);
END;
$function$;

-- 관리자 세션(authenticated)과 서버(service_role)만 호출한다. 비로그인 실행 권한은 회수.
REVOKE EXECUTE ON FUNCTION public.cancel_platform_event(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_nts_verification_result(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_supplier_verification(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_platform_event(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_nts_verification_result(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_supplier_verification(uuid, boolean) TO authenticated, service_role;

-- ②
DROP POLICY IF EXISTS "Retailer match requests insertable by anyone" ON public.retailer_match_requests;
CREATE POLICY "Retailer match requests insertable by anyone" ON public.retailer_match_requests
    FOR INSERT WITH CHECK (status = 'pending' AND admin_note IS NULL);

-- ④
ALTER TABLE public.platform_subscription_invoices
    DROP CONSTRAINT IF EXISTS platform_subscription_invoices_paid_amount_positive;
ALTER TABLE public.platform_subscription_invoices
    ADD CONSTRAINT platform_subscription_invoices_paid_amount_positive
    CHECK (paid_amount IS NULL OR paid_amount > 0) NOT VALID;
