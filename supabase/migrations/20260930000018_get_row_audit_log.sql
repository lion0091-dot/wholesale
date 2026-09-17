-- products/custom_prices/orders 공용 이력 조회 RPC. wholesaler_retailers 전용
-- RPC(20260930000017)와 달리 이 셋은 row_id로 직접 조회해도 안전하다 —
-- audit_log.row_id는 원본 행이 삭제돼도 그대로 남기 때문(삭제 이력도 함께 보임).
create or replace function public.get_row_audit_log(
    p_wholesaler_id uuid,
    p_table_name    text,
    p_row_id        uuid
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
     order by a.created_at desc;
$$;

revoke all on function public.get_row_audit_log(uuid, text, uuid) from public;
grant execute on function public.get_row_audit_log(uuid, text, uuid) to authenticated;
