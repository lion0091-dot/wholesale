-- 188: 대시보드 알림함 — "누가 거래처 여신 한도를 바꿨는지 / 거래를 정지·재개했는지"를 종 패널에서 보여준다.
--
-- 2026-10-01 사장님 결정: 이 3종은 대표에게 카톡(알림톡)까지 보낼 일이 아니라 화면 기록으로 충분하다.
-- 새 표는 만들지 않는다 — wholesaler_retailers 변경은 이미 audit_log(013 트리거)에 "누가·언제·전후값"이 남는다.
-- 이 RPC는 그중 credit_limit 또는 status가 실제로 바뀐 최근 14일치만 골라 거래처 이름·처리자 이름을 붙여 돌려준다.
--
-- 권한: 여신 한도 수정과 같은 기준 — 대표(wholesalers.profile_id) 또는 owner/manager 직원, 슈퍼관리자. 일반 직원은 빈 결과.
-- 종 패널이 열릴 때마다(Realtime 신호 포함) 부르므로 audit_log에 (table_name, created_at) 인덱스를 둔다.

create index if not exists idx_audit_log_table_created
    on public.audit_log (table_name, created_at desc);

create or replace function public.list_wholesaler_internal_notices(
    p_wholesaler_id uuid,
    p_limit         int default 10
)
returns table(
    id            bigint,
    kind          text,          -- 'credit_limit' | 'status'
    created_at    timestamptz,
    actor_name    text,
    retailer_id   uuid,
    retailer_name text,
    old_value     text,          -- credit_limit: 숫자 문자열 / status: 'active'|'blocked'
    new_value     text,
    reason        text           -- status가 blocked로 바뀔 때의 block_reason
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select a.id,
           case when a.old_data ->> 'credit_limit' is distinct from a.new_data ->> 'credit_limit'
                then 'credit_limit' else 'status' end as kind,
           a.created_at,
           coalesce(p.name, '담당자') as actor_name,
           (a.new_data ->> 'retailer_id')::uuid as retailer_id,
           coalesce(r.restaurant_name, '거래처') as retailer_name,
           case when a.old_data ->> 'credit_limit' is distinct from a.new_data ->> 'credit_limit'
                then a.old_data ->> 'credit_limit' else a.old_data ->> 'status' end as old_value,
           case when a.old_data ->> 'credit_limit' is distinct from a.new_data ->> 'credit_limit'
                then a.new_data ->> 'credit_limit' else a.new_data ->> 'status' end as new_value,
           case when a.new_data ->> 'status' = 'blocked' and a.old_data ->> 'status' is distinct from 'blocked'
                then a.new_data ->> 'block_reason' end as reason
      from public.audit_log a
      left join public.profiles p on p.id = a.changed_by
      left join public.retailers r on r.id = (a.new_data ->> 'retailer_id')::uuid
     where a.table_name = 'wholesaler_retailers'
       and a.action = 'update'
       and a.created_at >= now() - interval '14 days'
       and a.new_data ->> 'wholesaler_id' = p_wholesaler_id::text
       and (
            a.old_data ->> 'credit_limit' is distinct from a.new_data ->> 'credit_limit'
            or a.old_data ->> 'status' is distinct from a.new_data ->> 'status'
       )
       and (
            exists (select 1 from public.wholesalers w where w.id = p_wholesaler_id and w.profile_id = auth.uid())
            or public.is_org_staff_of_wholesaler(p_wholesaler_id, array['owner', 'manager']::organization_role[])
            or public.get_current_role() = 'super_admin'
       )
     order by a.created_at desc
     limit greatest(least(p_limit, 50), 0);
$$;

revoke all on function public.list_wholesaler_internal_notices(uuid, int) from public;
grant execute on function public.list_wholesaler_internal_notices(uuid, int) to authenticated;

-- 거래처 관계가 바뀌는 순간 종 패널이 다시 읽도록 Realtime 발행에 추가(187과 같은 방식, 재실행 안전).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'wholesaler_retailers'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.wholesaler_retailers;
    END IF;
END
$$;
