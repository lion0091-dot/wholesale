-- /code-review high(2026-09-17)에서 발견된 20260930000005 버그 2건 수정.

-- 1) RLS 정책에 super_admin 예외가 빠져있었다. app/actions/organization.ts의
--    createStaffInviteAction()/revokeStaffInviteAction()은 super_admin이면 조직
--    일치 여부를 확인하지 않고 통과시키는데, DB 정책이 owner/manager만 허용해서
--    실제로는 super_admin이 has_organization_role을 만족 못 하면 SELECT가 조용히
--    0건으로 필터링되어 "초대 링크를 찾을 수 없습니다"로 실패했다. 같은 기능 영역의
--    형제 테이블(organizations, organization_staff)이 이미 쓰는 패턴과 통일한다.
drop policy if exists "Staff invites manageable by org owner or manager" on public.organization_staff_invites;

create policy "Staff invites manageable by org owner, manager, or admin" on public.organization_staff_invites
    for all
    using (
        public.has_organization_role(organization_id, array['owner', 'manager']::public.organization_role[])
        or public.get_current_role() = 'super_admin'
    )
    with check (
        public.has_organization_role(organization_id, array['owner', 'manager']::public.organization_role[])
        or public.get_current_role() = 'super_admin'
    );

-- 2) claim_organization_staff_invite(): exists-then-insert는 두 요청이 동시에 들어오면
--    (더블클릭, 같은 카카오 계정으로 두 탭) 경합조건이 생겨 uq_organization_staff_user
--    유니크 제약 위반이 다듬어지지 않은 예외로 그대로 새어나갔다. INSERT를
--    예외 처리로 감싸 유니크 위반을 ALREADY_STAFF_ELSEWHERE로 매핑한다(기존
--    exists 사전 체크는 정상 경로에서 빠른 실패를 위해 유지).
create or replace function public.claim_organization_staff_invite(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid    uuid := auth.uid();
    v_invite public.organization_staff_invites%rowtype;
    v_role   text;
begin
    if v_uid is null then
        raise exception 'AUTH_REQUIRED';
    end if;

    select * into v_invite
      from public.organization_staff_invites
     where token = p_token
       and revoked_at is null
       and expires_at > now();

    if v_invite.id is null then
        raise exception 'INVALID_OR_EXPIRED_INVITE';
    end if;

    select role into v_role from public.profiles where id = v_uid;

    if v_role = 'retailer' then
        raise exception 'RETAILER_CANNOT_JOIN_STAFF';
    end if;

    if exists (select 1 from public.organization_staff where user_id = v_uid) then
        raise exception 'ALREADY_STAFF_ELSEWHERE';
    end if;

    if exists (select 1 from public.wholesalers where profile_id = v_uid) then
        raise exception 'WHOLESALER_OWNER_CANNOT_JOIN_AS_STAFF';
    end if;

    begin
        insert into public.organization_staff (organization_id, user_id, role, invited_by)
        values (v_invite.organization_id, v_uid, v_invite.role, v_invite.created_by);
    exception
        when unique_violation then
            raise exception 'ALREADY_STAFF_ELSEWHERE';
    end;

    update public.organization_staff_invites
       set used_count = used_count + 1
     where id = v_invite.id;

    return jsonb_build_object('organization_id', v_invite.organization_id, 'role', v_invite.role);
end;
$$;
