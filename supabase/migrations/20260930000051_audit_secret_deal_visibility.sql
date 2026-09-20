-- 시크릿딜 노출 대상(secret_deal_visibility) 지정/해제 이력 추적.
-- 지금까지 이 테이블은 grant/revoke만 있고 감사 로그가 전혀 안 붙어있었다 —
-- "누가 언제 어느 거래처에게 어떤 상품의 시크릿딜을 열어줬는지" 알 수 없었다.
-- products/custom_prices와 같은 범용 log_audit_event() 트리거를 그대로 재사용한다
-- (UPDATE는 없는 테이블이라 INSERT/DELETE만 건다 — RLS에도 update 정책이 없음).
create trigger trg_secret_deal_visibility_audit
    after insert or delete on public.secret_deal_visibility
    for each row execute function public.log_audit_event();

-- get_row_audit_log의 조회 대상 화이트리스트에 secret_deal_visibility 추가.
-- 파라미터/반환 타입이 20260930000049와 동일하므로 CREATE OR REPLACE로 대체 가능.
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
       and p_table_name in ('products', 'custom_prices', 'orders', 'secret_deal_visibility')
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
