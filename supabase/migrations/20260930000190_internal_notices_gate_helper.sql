-- 190: 알림함 RPC(188)의 권한 검사를 손으로 쓴 세 조건 대신 기존 헬퍼 can_manage_wholesaler(097)로 통일 (코드리뷰 2026-10-01).
-- 결과는 같다(대표 본인 / owner·manager 직원 / 슈퍼관리자). 헬퍼가 나중에 바뀌면(정지된 직원 제외 등) 여기도 같이 따라간다.

create or replace function public.list_wholesaler_internal_notices(
    p_wholesaler_id uuid,
    p_limit         int default 10
)
returns table(
    id            bigint,
    kind          text,
    created_at    timestamptz,
    actor_name    text,
    retailer_id   uuid,
    retailer_name text,
    old_value     text,
    new_value     text,
    reason        text
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
       and public.can_manage_wholesaler(p_wholesaler_id)
     order by a.created_at desc
     limit greatest(least(p_limit, 50), 0);
$$;
