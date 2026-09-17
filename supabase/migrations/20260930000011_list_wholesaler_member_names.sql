-- 화면에 "등록자/수정자" 이름을 보여주기 위한 조회 RPC.
--
-- list_organization_staff_with_profiles()는 organization_id 기준이라, 조직을 만들지
-- 않은 1인 공급사(온보딩만 마치고 organizations row가 없는 경우)는 커버하지 못한다.
-- products/custom_prices/orders의 created_by/updated_by는 두 경우 모두에서 채워지므로
-- wholesaler_id 하나로 "대표 본인 또는 그 조직 직원"을 통일해서 조회한다.
create or replace function public.list_wholesaler_member_names(p_wholesaler_id uuid)
returns table(user_id uuid, name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select p.id, p.name
      from public.profiles p
     where (
            p.id = (select w.profile_id from public.wholesalers w where w.id = p_wholesaler_id)
            or p.id in (
                select s.user_id
                  from public.organization_staff s
                  join public.organizations o on o.id = s.organization_id
                 where o.wholesaler_id = p_wholesaler_id
            )
       )
       and (
            exists (
                select 1 from public.wholesalers w2
                 where w2.id = p_wholesaler_id and w2.profile_id = auth.uid()
            )
            or exists (
                select 1
                  from public.organization_staff s2
                  join public.organizations o2 on o2.id = s2.organization_id
                 where o2.wholesaler_id = p_wholesaler_id and s2.user_id = auth.uid()
            )
            or public.get_current_role() = 'super_admin'
       );
$$;

revoke all on function public.list_wholesaler_member_names(uuid) from public;
grant execute on function public.list_wholesaler_member_names(uuid) to authenticated;
