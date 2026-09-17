-- withdraw_wholesaler_account() 보강: is_verified도 함께 false로 내린다.
--
-- wholesalers.status='closed'만으로는 canIssueInvite 우회 여지가 있었다 — 그 게이트가
-- "administrativelyApproved(=is_verified) && status!=='suspended'"였는데 'closed'는
-- suspended가 아니라서 is_verified가 true로 남아있으면 통과해버렸다(앱 레벨은 이미
-- lib/supplier/verification.ts에서 status!=='closed'도 추가로 막게 고쳤지만, "행정
-- 승인 완료" 자체를 뜻하는 is_verified 플래그도 사업 종료 후엔 true로 남아있으면
-- 안 되므로 DB 레벨에서도 같이 내려 이중 방어한다).
create or replace function public.withdraw_wholesaler_account()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

    update public.profiles
       set name = '탈퇴한 회원',
           phone = '',
           is_verified = false,
           withdrawn_at = now(),
           updated_at = now()
     where id = v_uid;

    return jsonb_build_object('wholesaler_id', v_wholesaler_id, 'closed', true);
end;
$$;
