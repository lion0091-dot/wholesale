-- 공급사가 거래처(소매)를 직접 "거래중지/재개"할 수 있는 기능.
--
-- 배경: 플랫폼 구독료가 거래중(active) 거래처 수 비례 종량제로 바뀌면서, 공급사가
-- 청구 시점 직전에 거래처를 blocked로 내렸다가 직후 다시 active로 되돌리는 식으로
-- 과금을 회피할 수 있다는 우려가 제기됨. 실제 불량 거래처(대금 미납 등) 관리는
-- 공급사에게 필요한 정당한 기능이라 막을 수는 없으므로, RPC 레벨에서 두 가지로
-- 방어한다:
--   1) 정지(active->blocked) 시 사유(block_reason) 필수 입력 — 감사 로그(기존
--      trg_wholesaler_retailers_audit)에 사유가 함께 남아 관리자가 남용 여부를
--      나중에 점검할 수 있다.
--   2) 재개(blocked->active) 시 최소 7일 냉각기간 — status_changed_at 기준.
--      "청구 시점만 피해서 바로 되돌리기"를 무력화한다. 실수요(오해로 정지한 경우
--      등)로 인한 불편은 감수 — 필요해지면 super_admin 수동 해제 경로를 별도로
--      열어줄 수 있다(현재는 없음).

alter table public.wholesaler_retailers
    add column if not exists status_changed_at timestamptz not null default now(),
    add column if not exists block_reason text;

-- 기존 행은 전부 지금 이 순간을 마지막 상태 변경 시점으로 본다(소급 냉각기간 없음).
update public.wholesaler_retailers set status_changed_at = now() where status_changed_at is null;

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

    if p_status = 'active'
       and v_current.status = 'blocked'
       and now() - v_current.status_changed_at < interval '7 days' then
        raise exception 'REACTIVATION_COOLDOWN';
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
