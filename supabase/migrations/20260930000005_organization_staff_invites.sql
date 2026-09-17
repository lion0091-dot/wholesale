-- 공급사(도매업체) 자체 직원 초대 — 카카오 OAuth 전용 구조에 맞춘 초대 링크.
--
-- app/actions/organization.ts의 inviteStaff()는 이메일 기반 Supabase 초대
-- (auth.admin.inviteUserByEmail)를 쓰는데, 이 플랫폼은 이미 전부 카카오 OAuth로
-- 전환됐고(이메일/비밀번호 가입 폐기) 그 화면(옛 /wholesaler/staff)도 이미 삭제된
-- 죽은 코드다. 바이어 shop_token 초대와 같은 패턴(토큰 링크 → 카카오 로그인 →
-- 자동 연결)으로 다시 만든다.
create table if not exists public.organization_staff_invites (
    id              uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    role            public.organization_role not null default 'staff',
    token           uuid not null default gen_random_uuid() unique,
    created_by      uuid not null references auth.users(id) on delete cascade,
    expires_at      timestamptz not null default (now() + interval '7 days'),
    revoked_at      timestamptz,
    used_count      integer not null default 0,
    created_at      timestamptz not null default now()
);

create index if not exists idx_organization_staff_invites_org
    on public.organization_staff_invites(organization_id);

alter table public.organization_staff_invites enable row level security;

-- owner/manager만 자기 조직의 초대 링크를 만들고/보고/회수(revoked_at 설정)할 수 있다.
create policy "Staff invites manageable by org owner or manager" on public.organization_staff_invites
    for all
    using (public.has_organization_role(organization_id, array['owner', 'manager']::public.organization_role[]))
    with check (public.has_organization_role(organization_id, array['owner', 'manager']::public.organization_role[]));

grant select, insert, update on public.organization_staff_invites to authenticated;

-- 초대 랜딩 화면(로그인 전)이 "OO 업체에 합류하기"를 보여줄 수 있도록 하는
-- 익명 안전 조회 — 조직 이름만 반환하고 그 외 정보는 노출하지 않는다.
create or replace function public.get_staff_invite_info(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'valid', true,
        'organization_name', o.name
    )
    from public.organization_staff_invites i
    join public.organizations o on o.id = i.organization_id
    where i.token = p_token
      and i.revoked_at is null
      and i.expires_at > now();
$$;

revoke all on function public.get_staff_invite_info(uuid) from public;
grant execute on function public.get_staff_invite_info(uuid) to anon, authenticated;

-- 초대 수락: 카카오 로그인한 본인을 초대 링크가 가리키는 조직의 직원으로 등록한다.
-- 이미 다른 조직 직원이거나, 본인 명의 wholesalers(업체 대표)가 있거나, 바이어로
-- 확정된 계정이면 거절한다 — 한 계정이 여러 역할/여러 업체에 걸치는 걸 막는다.
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

    insert into public.organization_staff (organization_id, user_id, role, invited_by)
    values (v_invite.organization_id, v_uid, v_invite.role, v_invite.created_by);

    update public.organization_staff_invites
       set used_count = used_count + 1
     where id = v_invite.id;

    return jsonb_build_object('organization_id', v_invite.organization_id, 'role', v_invite.role);
end;
$$;

revoke all on function public.claim_organization_staff_invite(uuid) from public;
grant execute on function public.claim_organization_staff_invite(uuid) to authenticated;
