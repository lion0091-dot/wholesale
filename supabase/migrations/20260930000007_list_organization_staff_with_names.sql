-- profiles SELECT RLS("Profiles viewable by self or admin")는 본인 것만 허용해서,
-- listOrganizationStaff()가 반환하는 user_id만으로는 /dashboard/team 화면에 팀원
-- 이름을 표시할 수 없다. 같은 조직 구성원의 이름/연락처만 노출하는 조회 전용 RPC.
create or replace function public.list_organization_staff_with_profiles(p_organization_id uuid)
returns table(
    id         uuid,
    user_id    uuid,
    role       public.organization_role,
    name       text,
    phone      text,
    created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select s.id, s.user_id, s.role, p.name, p.phone, s.created_at
      from public.organization_staff s
      join public.profiles p on p.id = s.user_id
     where s.organization_id = p_organization_id
       and (
            public.has_organization_role(
                p_organization_id, array['owner', 'manager', 'staff']::public.organization_role[]
            )
            or public.get_current_role() = 'super_admin'
       )
     order by s.created_at asc;
$$;

revoke all on function public.list_organization_staff_with_profiles(uuid) from public;
grant execute on function public.list_organization_staff_with_profiles(uuid) to authenticated;
