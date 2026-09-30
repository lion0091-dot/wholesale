-- 168: 탈퇴 처리 변경 2건 (2026-09-30, 사장님 승인)
-- (1) 고객 탈퇴: 상호·사업자번호는 남긴다. 공급사가 매출 거래 상대방을 기록·보관해야 하므로(보관의무),
--     즉시 지우던 것을 대표자명·주소만 지우는 것으로 바꾼다. 남긴 상호·사업자번호는 탈퇴 5년 뒤 167의 파기 함수가 지운다.
--     본문은 로컬 DB의 pg_get_functiondef 기준(미정산 외상 보류 포함)으로 패치했다.
-- (2) 탈퇴 계정의 로그인 수단 정보 정리: auth.identities.identity_data(카카오 이메일·닉네임 등)를 비우고
--     소셜 식별자(sub)만 남긴다 — 같은 카카오 계정이 다시 가입해 정지된 계정과 충돌 없이 막히도록.
--     서버(service_role)가 탈퇴 직후 호출한다.

create or replace function public.withdraw_retailer_account()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid         uuid := auth.uid();
    v_role        text;
    v_retailer_id uuid;
    v_outstanding numeric;
begin
    if v_uid is null then
        raise exception 'AUTH_REQUIRED';
    end if;

    select role into v_role from public.profiles where id = v_uid;
    if v_role <> 'retailer' then
        raise exception 'NOT_A_RETAILER_ACCOUNT';
    end if;

    select id into v_retailer_id from public.retailers where profile_id = v_uid;
    if v_retailer_id is null then
        raise exception 'RETAILER_NOT_FOUND';
    end if;

    -- 미정산 외상이 남아 있으면 탈퇴 보류(2026-09-24 사장님 결정, 공급사 탈퇴와 동일 규칙).
    select coalesce(sum(outstanding_balance), 0) into v_outstanding
      from public.wholesaler_retailers
     where retailer_id = v_retailer_id;

    if v_outstanding > 0 then
        raise exception 'OUTSTANDING_BALANCE_EXISTS';
    end if;

    update public.profiles
       set name = '탈퇴한 회원',
           phone = '',
           withdrawn_at = now(),
           updated_at = now()
     where id = v_uid;

    -- 상호·사업자번호는 유지(보관의무), 대표자명·주소만 즉시 삭제
    update public.retailers
       set representative_name = '탈퇴한 회원',
           delivery_address = '',
           delivery_address_detail = null,
           updated_at = now()
     where id = v_retailer_id;

    return jsonb_build_object('retailer_id', v_retailer_id, 'withdrawn', true);
end;
$$;

revoke all on function public.withdraw_retailer_account() from public;
grant execute on function public.withdraw_retailer_account() to authenticated;

create or replace function public.scrub_withdrawn_login_identity(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
    v_count integer;
begin
    -- 탈퇴 처리된 계정만
    if not exists (select 1 from public.profiles where id = p_user_id and withdrawn_at is not null) then
        return 0;
    end if;

    update auth.identities
       set identity_data = case when identity_data ? 'sub'
                                then jsonb_build_object('sub', identity_data->>'sub')
                                else '{}'::jsonb end,
           updated_at = now()
     where user_id = p_user_id;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

revoke all on function public.scrub_withdrawn_login_identity(uuid) from public, anon, authenticated;
grant execute on function public.scrub_withdrawn_login_identity(uuid) to service_role;
