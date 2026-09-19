-- 변경 이력 조회 RPC 2개(get_row_audit_log, get_wholesaler_retailer_audit_log)에
-- limit/offset을 추가한다. 오래 쓰는 상품/거래처일수록 수정 횟수가 쌓여 이력이
-- 무한정 길어질 수 있는데, 지금까지는 전체를 한 번에 반환했다 — 화면에서
-- "10개씩 + 더보기"로 나눠 보여주기 위해 서버에서부터 페이지 단위로 끊는다.
--
-- 파라미터 개수가 바뀌므로(3개 -> 5개) CREATE OR REPLACE로는 기존 함수를 대체하지
-- 못하고 새 오버로드가 생겨버린다 — 이름 기반 RPC 호출이 어느 쪽을 타는지 모호해지므로
-- 기존 시그니처를 명시적으로 DROP 한 뒤 새로 만든다.

drop function if exists public.get_row_audit_log(uuid, text, uuid);

create or replace function public.get_row_audit_log(
    p_wholesaler_id uuid,
    p_table_name    text,
    p_row_id        uuid,
    p_limit         int default 10,
    p_offset        int default 0
)
returns table(
    id         bigint,
    action     text,
    changed_by uuid,
    old_data   jsonb,
    new_data   jsonb,
    created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select a.id, a.action, a.changed_by, a.old_data, a.new_data, a.created_at
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

drop function if exists public.get_wholesaler_retailer_audit_log(uuid, uuid);

create or replace function public.get_wholesaler_retailer_audit_log(
    p_wholesaler_id uuid,
    p_retailer_id   uuid,
    p_limit         int default 10,
    p_offset        int default 0
)
returns table(
    id         bigint,
    action     text,
    changed_by uuid,
    old_data   jsonb,
    new_data   jsonb,
    created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select a.id, a.action, a.changed_by, a.old_data, a.new_data, a.created_at
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
