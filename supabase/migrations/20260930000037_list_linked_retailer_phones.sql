-- ====================================================================
-- 거래처(고객) 전화번호 조회 RPC — "문자로 바로 보내기" 기능 지원
--
-- profiles SELECT RLS("Profiles viewable by self or admin")는 본인 것만
-- 허용해서, 공급사가 자기 거래처의 phone을 직접 조회할 수 없다
-- (list_wholesaler_member_names와 동일한 근본 원인, 20260930000011 참고).
-- 이 RPC는 "실제로 연결된(active) 거래처"로 범위를 좁혀서만 우회를 허용한다.
-- ====================================================================
create or replace function public.list_linked_retailer_phones(p_wholesaler_id uuid)
returns table(retailer_id uuid, phone text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select r.id, p.phone
      from public.retailers r
      join public.profiles p on p.id = r.profile_id
      join public.wholesaler_retailers wr on wr.retailer_id = r.id
     where wr.wholesaler_id = p_wholesaler_id
       and wr.status = 'active'
       and (
            exists (
                select 1 from public.wholesalers w
                 where w.id = p_wholesaler_id and w.profile_id = auth.uid()
            )
            or public.is_org_staff_of_wholesaler(p_wholesaler_id)
            or public.get_current_role() = 'super_admin'
       );
$$;

revoke all on function public.list_linked_retailer_phones(uuid) from public;
grant execute on function public.list_linked_retailer_phones(uuid) to authenticated;
