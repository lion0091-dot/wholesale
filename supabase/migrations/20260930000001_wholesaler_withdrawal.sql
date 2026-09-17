-- 공급사(도매업체) 회원탈퇴 = 사업 종료(폐업) 처리.
--
-- 바이어 탈퇴(20260930000000)와 달리 상호/사업자번호/대표자명/주소는 지우지 않는다 —
-- 이건 연결된 고객들의 과거 거래 내역에도 남아있는 "사업자 정보"라서, 지워버리면
-- 고객이 자기 주문 이력에서 "누구한테 샀는지"를 잃는다(개인정보가 아니라 상거래 기록).
-- 대신 wholesalers.status를 'closed'로 바꿔 신규 주문/초대장 발부만 막는다
-- (미니샵은 status!=='active'면 이미 카탈로그를 열지 않으므로 추가 배선 없이 막힌다).
--
-- 실행 계정 본인의 profiles(name/phone)만 바이어와 동일하게 익명화한다 — 이건
-- 그 사람 개인 정보라 지워도 상거래 기록에 영향이 없다.
--
-- 미수금(wholesaler_retailers.outstanding_balance)이 하나라도 남아있으면 차단한다 —
-- 정산 안 끝난 채로 폐업 처리되면 그 미수금 추적이 애매해진다.
alter table public.wholesalers
    drop constraint wholesalers_status_check,
    add constraint wholesalers_status_check
        check (status in ('pending', 'active', 'suspended', 'rejected', 'closed'));

comment on column public.wholesalers.status is
    '공급사 상태. pending=승인대기, active=정상영업, suspended=이용정지(운영팀), rejected=가입거절, closed=사업종료(본인 탈퇴).';

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

    -- 업체 대표(가입 당사자) 본인만 사업 종료를 실행할 수 있다 — 조직 직원은 불가.
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
           withdrawn_at = now(),
           updated_at = now()
     where id = v_uid;

    return jsonb_build_object('wholesaler_id', v_wholesaler_id, 'closed', true);
end;
$$;

revoke all on function public.withdraw_wholesaler_account() from public;
grant execute on function public.withdraw_wholesaler_account() to authenticated;
