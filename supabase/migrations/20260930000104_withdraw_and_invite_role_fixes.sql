-- ====================================================================
-- 가입·로그인 점검(2026-09-24, scripts/db-test-signup-and-accounts.sql)에서 나온 문제 2개
--
-- (1) 승인된 공급사의 사업 종료(탈퇴)가 안 됐다.
--     withdraw_wholesaler_account가 profiles.is_verified를 false로 내리는데,
--     enforce_profile_role_immutable 트리거가 "승인 상태는 스스로 변경할 수 없습니다"로 막는다.
--     앱(withdrawWholesalerAccountAction)은 이 RPC를 본인 세션으로 부르므로 화면엔
--     "사업 종료 처리에 실패했습니다"만 떴다(미승인 공급사만 탈퇴가 됐음).
--     set_supplier_verification과 같은 내부 플래그(app.supplier_onboarding)로 감싼다.
--
-- (2) 매니저가 owner 초대 링크를 만들 수 있었다.
--     organization_staff_invites RLS(ALL, owner/manager)는 역할 컬럼을 안 보고, 앱의
--     canAssignRole은 화면 경로만 막는다. API로 role='owner' 초대를 만들어 지인이 수락하면
--     사장 권한을 얻는다(기존 초대의 role을 owner로 바꾸는 것도 같은 경로).
--     "owner 초대는 그 조직의 owner 또는 super_admin만" 트리거를 INSERT·UPDATE에 단다.
-- ====================================================================

-- --------------------------------------------------------------------
-- (1) withdraw_wholesaler_account — 프로필 갱신을 내부 플래그로 감싼다
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.withdraw_wholesaler_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
declare
    v_uid           uuid := auth.uid();
    v_wholesaler_id uuid;
    v_status        text;
    v_outstanding   numeric;
begin
    if v_uid is null then
        raise exception 'AUTH_REQUIRED';
    end if;

    select id, status into v_wholesaler_id, v_status
      from public.wholesalers
     where profile_id = v_uid;

    if v_wholesaler_id is null then
        raise exception 'NOT_A_WHOLESALER_OWNER';
    end if;

    if v_status = 'closed' then
        raise exception 'ALREADY_CLOSED';
    end if;

    select coalesce(sum(outstanding_balance), 0) into v_outstanding
      from public.wholesaler_retailers
     where wholesaler_id = v_wholesaler_id;

    if v_outstanding > 0 then
        raise exception 'OUTSTANDING_BALANCE_EXISTS';
    end if;

    update public.wholesalers
       set status = 'closed',
           updated_at = now()
     where id = v_wholesaler_id;

    -- is_verified를 내리는 건 enforce_profile_role_immutable이 막으므로, 승인 플래그 함수
    -- (set_supplier_verification)와 같은 내부 플래그로 이 갱신만 통과시킨다.
    perform set_config('app.supplier_onboarding', 'on', true);
    update public.profiles
       set name = '탈퇴한 회원',
           phone = '',
           is_verified = false,
           withdrawn_at = now(),
           updated_at = now()
     where id = v_uid;
    perform set_config('app.supplier_onboarding', 'off', true);

    return jsonb_build_object('wholesaler_id', v_wholesaler_id, 'closed', true);
end;
$$;

-- --------------------------------------------------------------------
-- (2) owner 초대는 owner/super_admin만
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_staff_invite_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.role = 'owner'
       AND NOT public.has_organization_role(NEW.organization_id, ARRAY['owner'::organization_role])
       AND public.get_current_role() IS DISTINCT FROM 'super_admin' THEN
        RAISE EXCEPTION 'OWNER_INVITE_REQUIRES_OWNER';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_invites_role ON public.organization_staff_invites;
CREATE TRIGGER trg_staff_invites_role
    BEFORE INSERT OR UPDATE OF role ON public.organization_staff_invites
    FOR EACH ROW EXECUTE FUNCTION public.enforce_staff_invite_role();

COMMENT ON FUNCTION public.enforce_staff_invite_role() IS
    'owner 역할 초대 링크는 그 조직의 owner 또는 super_admin만 만들거나 바꿀 수 있다(앱 canAssignRole의 DB판).';
