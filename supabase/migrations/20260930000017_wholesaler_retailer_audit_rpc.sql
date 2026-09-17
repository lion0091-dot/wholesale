-- 여신(credit_limit/outstanding_balance/status) 변경 이력 조회 RPC.
--
-- audit_log.row_id로 wholesaler_retailers를 조인하지 않는다 — 행이 나중에 삭제되면
-- (예: 차단 대신 실제 삭제되는 경우) 조인이 끊겨 삭제 이력 자체를 잃는다. 대신
-- old_data/new_data JSONB에 이미 들어있는 wholesaler_id/retailer_id로 직접 필터링해
-- 원본 행의 생존 여부와 무관하게 이력이 항상 조회되게 한다.
create or replace function public.get_wholesaler_retailer_audit_log(
    p_wholesaler_id uuid,
    p_retailer_id   uuid
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
     order by a.created_at desc;
$$;

revoke all on function public.get_wholesaler_retailer_audit_log(uuid, uuid) from public;
grant execute on function public.get_wholesaler_retailer_audit_log(uuid, uuid) to authenticated;
