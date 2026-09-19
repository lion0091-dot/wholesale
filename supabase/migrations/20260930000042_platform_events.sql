-- 플랫폼 마케팅/할인 이벤트 (구독료 할인) — 관리자가 자유기입 이름의 이벤트를 만들어
-- 전체 공급사(common) 또는 특정 공급사만(individual) 구독료를 할인해줄 수 있다.
--
-- 잠긴 설계 결정:
-- - 기간은 "시작일 + 기간(일수)"로 입력받고 종료일은 생성 컬럼으로 자동 계산한다
--   (starts_on + duration_days, date + integer는 그 일수만큼 뒤의 date를 반환한다).
-- - 한 번 만들면 수정 불가 — 취소(status='cancelled')만 가능하고 하드 삭제는 없다.
--   이력 조회 화면이 곧 "전체 이벤트 목록"이라 삭제하면 이력이 사라지기 때문이다.
--   그래서 UPDATE RLS 정책 자체를 두지 않고, 취소는 cancel_platform_event() RPC
--   (security definer)로만 status 컬럼을 건드리게 막는다.
-- - individual 이벤트는 platform_event_suppliers에 매핑된 업체만 대상이고, 업체별로
--   할인율을 override할 수 있다(null이면 이벤트 기본 할인율 적용).
-- - "누가 만들었는지"는 products와 동일한 패턴(컬럼 기본값 auth.uid())으로 자동 기록.
create table public.platform_events (
    id             uuid primary key default gen_random_uuid(),
    name           text not null check (length(trim(name)) > 0),
    discount_rate  numeric not null check (discount_rate >= 0 and discount_rate <= 100),
    event_type     text not null check (event_type in ('common', 'individual')),
    starts_on      date not null,
    duration_days  integer not null check (duration_days > 0),
    ends_on        date generated always as (starts_on + duration_days) stored,
    status         text not null default 'active' check (status in ('active', 'cancelled')),
    created_by     uuid references auth.users(id) on delete set null default auth.uid(),
    created_at     timestamptz not null default now(),
    cancelled_by   uuid references auth.users(id) on delete set null,
    cancelled_at   timestamptz
);

comment on column public.platform_events.created_by is '이벤트를 개설한 super_admin 계정 — 컬럼 기본값으로 자동 기록.';
comment on column public.platform_events.ends_on is 'starts_on + duration_days로 자동 계산되는 생성 컬럼(수정 불가).';

create table public.platform_event_suppliers (
    id             uuid primary key default gen_random_uuid(),
    event_id       uuid not null references public.platform_events(id) on delete cascade,
    wholesaler_id  uuid not null references public.wholesalers(id) on delete cascade,
    discount_rate  numeric check (discount_rate is null or (discount_rate >= 0 and discount_rate <= 100)),
    created_at     timestamptz not null default now(),
    unique (event_id, wholesaler_id)
);

comment on column public.platform_event_suppliers.discount_rate is 'null이면 platform_events.discount_rate(이벤트 기본값)를 그대로 쓴다.';

create index idx_platform_event_suppliers_wholesaler on public.platform_event_suppliers(wholesaler_id);

alter table public.platform_events enable row level security;
alter table public.platform_event_suppliers enable row level security;

-- 대문 배너용 — 공통(전체 공급사) + 진행중 이벤트만 비로그인 포함 누구나 조회 가능.
create policy "Common active events are publicly viewable" on public.platform_events
    for select
    using (event_type = 'common' and status = 'active');

create policy "Platform events fully viewable by super_admin" on public.platform_events
    for select using (public.get_current_role() = 'super_admin');

create policy "Platform events insertable by super_admin" on public.platform_events
    for insert
    with check (public.get_current_role() = 'super_admin');

create policy "Platform event suppliers viewable by super_admin" on public.platform_event_suppliers
    for select using (public.get_current_role() = 'super_admin');

create policy "Platform event suppliers insertable by super_admin" on public.platform_event_suppliers
    for insert
    with check (public.get_current_role() = 'super_admin');

-- 취소 전용 RPC. status 컬럼 하나만 건드리도록 막아서(테이블엔 UPDATE 정책 자체가 없음)
-- "한 번 만들면 고정, 취소만 가능" 원칙을 DB 레벨에서 강제한다.
create or replace function public.cancel_platform_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if public.get_current_role() <> 'super_admin' then
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
$$;

revoke all on function public.cancel_platform_event(uuid) from public;
grant execute on function public.cancel_platform_event(uuid) to authenticated;

-- 공급사(또는 그 조직 직원) 본인의 이번 달 적용 할인율 조회.
--
-- 이벤트 기간이 이번 달과 "일부만" 겹치면(예: 30일짜리 달에 10일만 이벤트 기간이면)
-- 할인율 자체를 겹친 일수 비율만큼 희석해서 적용한다 — billing_starts_at 일할 계산과
-- 같은 원칙이다. 예) 20% 할인 이벤트가 이번 달 30일 중 10일만 겹치면 실효 할인율은
-- 20% × (10/30) ≈ 6.7%. 여러 이벤트가 겹치면 각각 이렇게 계산한 뒤 합산(100% 상한).
-- security definer라 platform_event_suppliers를 직접 조회할 SELECT 권한이 일반
-- 사용자에게 없어도 동작한다.
create or replace function public.get_active_event_discount(
    p_wholesaler_id uuid,
    p_month_start date,
    p_month_end_exclusive date
)
returns table(discount_rate numeric, event_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select
        least(100, coalesce(sum(
            coalesce(pes.discount_rate, pe.discount_rate)
            * (least(pe.ends_on, p_month_end_exclusive - 1) - greatest(pe.starts_on, p_month_start) + 1)::numeric
            / (p_month_end_exclusive - p_month_start)::numeric
        ), 0)) as discount_rate,
        nullif(string_agg(pe.name, ' + ' order by pe.starts_on), '') as event_name
      from public.platform_events pe
      left join public.platform_event_suppliers pes
        on pes.event_id = pe.id and pes.wholesaler_id = p_wholesaler_id
     where pe.status = 'active'
       and pe.starts_on < p_month_end_exclusive
       and pe.ends_on >= p_month_start
       and (
            pe.event_type = 'common'
            or (pe.event_type = 'individual' and pes.wholesaler_id is not null)
       )
       and (
            exists (
                select 1 from public.wholesalers w
                 where w.id = p_wholesaler_id and w.profile_id = auth.uid()
            )
            or exists (
                select 1
                  from public.organization_staff s
                  join public.organizations o on o.id = s.organization_id
                 where o.wholesaler_id = p_wholesaler_id and s.user_id = auth.uid()
            )
            or public.get_current_role() = 'super_admin'
       );
$$;

revoke all on function public.get_active_event_discount(uuid, date, date) from public;
grant execute on function public.get_active_event_discount(uuid, date, date) to authenticated;
