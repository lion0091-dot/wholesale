-- wholesaler_retailers UPDATE 정책이 get_current_wholesaler_id()(원 가입자 본인)로만
-- 막혀있어서, 조직 직원(owner/manager 포함)은 여신 한도를 바꿀 수 없었다.
-- custom_prices 관리 정책(20260911010000)과 같은 패턴으로 owner/manager 직원도 허용한다.
drop policy if exists "Wholesaler retailers updatable by owner wholesaler" on public.wholesaler_retailers;

create policy "Wholesaler retailers updatable by owner or manager" on public.wholesaler_retailers
    for update
    using (
        wholesaler_id = public.get_current_wholesaler_id()
        or exists (
            select 1
              from public.organization_staff s
              join public.organizations o on o.id = s.organization_id
             where o.wholesaler_id = public.wholesaler_retailers.wholesaler_id
               and s.user_id = auth.uid()
               and s.role = any(array['owner', 'manager']::public.organization_role[])
        )
        or public.get_current_role() = 'super_admin'
    )
    with check (
        wholesaler_id = public.get_current_wholesaler_id()
        or exists (
            select 1
              from public.organization_staff s
              join public.organizations o on o.id = s.organization_id
             where o.wholesaler_id = public.wholesaler_retailers.wholesaler_id
               and s.user_id = auth.uid()
               and s.role = any(array['owner', 'manager']::public.organization_role[])
        )
        or public.get_current_role() = 'super_admin'
    );
