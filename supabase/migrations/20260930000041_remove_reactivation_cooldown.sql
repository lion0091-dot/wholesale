-- 거래처 거래 재개(blocked -> active) 시 7일 냉각기간(REACTIVATION_COOLDOWN) 제거.
--
-- 배경: 구독료 과금 기준이 'wholesaler_retailers.status = active 거래처 수'에서
-- '당월 실발주(주문 발생) 거래처 수'로 전환되면서, 과금 회피 방지용으로 두었던
-- 7일 냉각기간이 더 이상 불필요해짐. 오해로 정지했거나 대금이 즉시 입금된 경우
-- 공급사가 즉시 거래를 재개할 수 있도록 제약을 제거한다.
-- (거래중지 시 사유 block_reason 필수 입력은 불량거래처 관리 감사 로그용으로 유지)

create or replace function public.set_wholesaler_retailer_status(
    p_retailer_id uuid,
    p_status text,
    p_reason text default null
)
returns table(retailer_id uuid, status text, status_changed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_wholesaler_id uuid := coalesce(
        public.get_current_wholesaler_id(),
        (
            select o.wholesaler_id
              from public.organization_staff s
              join public.organizations o on o.id = s.organization_id
             where s.user_id = auth.uid()
               and s.role = any(array['owner', 'manager']::public.organization_role[])
             limit 1
        )
    );
    v_current record;
begin
    if v_wholesaler_id is null then
        raise exception 'NOT_A_WHOLESALER';
    end if;

    if p_status not in ('active', 'blocked') then
        raise exception 'INVALID_STATUS';
    end if;

    if p_status = 'blocked' and coalesce(trim(p_reason), '') = '' then
        raise exception 'BLOCK_REASON_REQUIRED';
    end if;

    select wr.status, wr.status_changed_at
      into v_current
      from public.wholesaler_retailers wr
     where wr.wholesaler_id = v_wholesaler_id
       and wr.retailer_id = p_retailer_id
       for update;

    if not found then
        raise exception 'RETAILER_NOT_FOUND';
    end if;

    if v_current.status = p_status then
        raise exception 'STATUS_UNCHANGED';
    end if;

    update public.wholesaler_retailers wr
       set status = p_status,
           status_changed_at = now(),
           block_reason = case when p_status = 'blocked' then p_reason else null end
     where wr.wholesaler_id = v_wholesaler_id
       and wr.retailer_id = p_retailer_id;

    return query
        select wr.retailer_id, wr.status, wr.status_changed_at
          from public.wholesaler_retailers wr
         where wr.wholesaler_id = v_wholesaler_id
           and wr.retailer_id = p_retailer_id;
end;
$$;

revoke all on function public.set_wholesaler_retailer_status(uuid, text, text) from public;
grant execute on function public.set_wholesaler_retailer_status(uuid, text, text) to authenticated;
