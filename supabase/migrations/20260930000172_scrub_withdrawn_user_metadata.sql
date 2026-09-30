-- 172: 탈퇴 계정의 로그인 메타데이터(auth.users.raw_user_meta_data)까지 비운다.
--
-- 171까지는 auth.identities만 정리했다. 카카오 로그인 때 저장된 이름·닉네임·프로필 이미지·이메일 사본은
-- auth.users.raw_user_meta_data에도 있는데, 탈퇴 코드의 admin.updateUserById({ user_metadata: {} })는
-- 키를 병합만 하고 지우지 않는다(로컬 인증 서버에서 재현) — 그대로 남아 방침("탈퇴 즉시 삭제")과 어긋났다.
-- 정리 함수 한 곳에서 identities와 메타데이터를 함께 비운다. 반환값(identities 행 수)은 그대로다.

create or replace function public.scrub_withdrawn_login_identity(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
    v_count integer;
begin
    if not exists (select 1 from public.profiles where id = p_user_id and withdrawn_at is not null) then
        return 0;
    end if;

    update auth.identities
       set identity_data = case when identity_data ? 'sub'
                                then jsonb_build_object('sub', 'withdrawn')
                                else '{}'::jsonb end,
           provider_id = 'withdrawn-' || user_id::text,
           updated_at = now()
     where user_id = p_user_id;
    get diagnostics v_count = row_count;

    update auth.users
       set raw_user_meta_data = '{}'::jsonb
     where id = p_user_id
       and raw_user_meta_data <> '{}'::jsonb;

    return v_count;
end;
$$;

revoke all on function public.scrub_withdrawn_login_identity(uuid) from public, anon, authenticated;
grant execute on function public.scrub_withdrawn_login_identity(uuid) to service_role;

-- 이미 탈퇴한 계정의 남은 메타데이터도 한 번 비운다(라이브 기준 0건).
update auth.users u
   set raw_user_meta_data = '{}'::jsonb
  from public.profiles p
 where p.id = u.id
   and p.withdrawn_at is not null
   and u.raw_user_meta_data <> '{}'::jsonb;
