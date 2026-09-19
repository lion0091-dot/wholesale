-- get_row_audit_log / get_wholesaler_retailer_audit_log(20260930000048)에 total_count를
-- 추가한다. 화면에서 "총 N건"과 "M / N건 조회됨"을 보여주려면 전체 개수가 필요한데,
-- 별도 count 쿼리를 한 번 더 날리는 대신 count(*) over()로 같은 쿼리에서 함께 반환한다
-- (윈도우 함수는 LIMIT/OFFSET 적용 전, WHERE를 통과한 전체 행 기준으로 계산되므로
-- 페이지에 상관없이 항상 전체 개수를 담고 있다).
--
-- total_count가 각 행에 반복해서 실리는 대신 반환 컬럼이 늘어나 리턴 타입이 바뀌므로
-- CREATE OR REPLACE로 대체할 수 없다 — 20260930000048의 5-파라미터 시그니처를 명시적으로
-- DROP한 뒤 새로 만든다.

drop function if exists public.get_row_audit_log(uuid, text, uuid, int, int);

create or replace function public.get_row_audit_log(
    p_wholesaler_id uuid,
    p_table_name    text,
    p_row_id        uuid,
    p_limit         int default 10,
    p_offset        int default 0
)
returns table(
    id          bigint,
    action      text,
    changed_by  uuid,
    old_data    jsonb,
    new_data    jsonb,
    created_at  timestamptz,
    total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select a.id, a.action, a.changed_by, a.old_data, a.new_data, a.created_at,
           count(*) over () as total_count
      from public.audit_log a
     where a.table_name = p_table_name
       and a.row_id = p_row_id
       and p_table_name in ('products', 'custom_prices', 'orders')
       and coalesce(a.new_data, a.old_data) ->> 'wholesaler_id' = p_wholesaler_id::text
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
       )
     order by a.created_at desc
     limit greatest(p_limit, 0)
    offset greatest(p_offset, 0);
$$;

revoke all on function public.get_row_audit_log(uuid, text, uuid, int, int) from public;
grant execute on function public.get_row_audit_log(uuid, text, uuid, int, int) to authenticated;

drop function if exists public.get_wholesaler_retailer_audit_log(uuid, uuid, int, int);

create or replace function public.get_wholesaler_retailer_audit_log(
    p_wholesaler_id uuid,
    p_retailer_id   uuid,
    p_limit         int default 10,
    p_offset        int default 0
)
returns table(
    id          bigint,
    action      text,
    changed_by  uuid,
    old_data    jsonb,
    new_data    jsonb,
    created_at  timestamptz,
    total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select a.id, a.action, a.changed_by, a.old_data, a.new_data, a.created_at,
           count(*) over () as total_count
      from public.audit_log a
     where a.table_name = 'wholesaler_retailers'
       and coalesce(a.new_data, a.old_data) ->> 'wholesaler_id' = p_wholesaler_id::text
       and coalesce(a.new_data, a.old_data) ->> 'retailer_id' = p_retailer_id::text
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
       )
     order by a.created_at desc
     limit greatest(p_limit, 0)
    offset greatest(p_offset, 0);
$$;

revoke all on function public.get_wholesaler_retailer_audit_log(uuid, uuid, int, int) from public;
grant execute on function public.get_wholesaler_retailer_audit_log(uuid, uuid, int, int) to authenticated;
