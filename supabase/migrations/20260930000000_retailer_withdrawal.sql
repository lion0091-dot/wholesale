-- 바이어(구매회원) 회원탈퇴.
--
-- 완전 삭제 대신 "개인정보 익명화 + 로그인 영구 차단"으로 처리한다. orders/order_items에는
-- 손대지 않는다 — 전자상거래법상 계약/결제 기록 보관 의무(통상 5년)가 있어, 탈퇴했다고
-- 주문 이력 자체를 지우면 오히려 법 위반이 될 수 있다. retailers row도 삭제하지 않고
-- 이름/연락처/사업자번호/배송지만 지운다 — 삭제하면 orders.retailer_id가 참조하는 행이
-- 없어져 기존 주문의 "공급받는자" 정보를 완전히 잃는다.
--
-- 실제 로그인 차단(auth.users banned_until)은 이 RPC가 아니라 서버 액션에서
-- service_role Admin API(auth.admin.updateUserById)로 별도 수행한다 — Postgres
-- 함수에서 auth 스키마를 직접 손대지 않고 Supabase가 지원하는 공식 경로만 쓴다.
alter table public.profiles
    add column withdrawn_at timestamptz;

comment on column public.profiles.withdrawn_at is
    '회원탈퇴 처리 시각. null이면 정상 계정. 탈퇴 처리는 withdraw_retailer_account() RPC + 서버의 Auth Admin API 계정 정지가 함께 이뤄져야 완료된다.';

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

    update public.profiles
       set name = '탈퇴한 회원',
           phone = '',
           withdrawn_at = now(),
           updated_at = now()
     where id = v_uid;

    update public.retailers
       set restaurant_name = '탈퇴한 회원',
           representative_name = '탈퇴한 회원',
           business_number = null,
           delivery_address = '',
           delivery_address_detail = null,
           updated_at = now()
     where id = v_retailer_id;

    return jsonb_build_object('retailer_id', v_retailer_id, 'withdrawn', true);
end;
$$;

revoke all on function public.withdraw_retailer_account() from public;
grant execute on function public.withdraw_retailer_account() to authenticated;
