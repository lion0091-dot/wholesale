-- 171: (1) 탈퇴 계정의 카카오 식별자(auth.identities.provider_id)까지 무의미한 값으로 교체
--      (2) 접속기록 표(access_log) 신설 — 개인정보의 안전성 확보조치 기준(접속기록 보관·점검) 대응, 사장님 승인
--
-- (1) 168은 identity_data(이메일·닉네임)만 비웠고 카카오 계정 번호(provider_id 열)는 남아 있었다.
--     보존 근거가 없는 식별자이므로 함께 바꾼다. 같은 사람이 나중에 다시 가입하면 새 계정이 만들어진다(정상적인 재가입).
-- (2) 기록하는 것: 누가(user_id) 언제 어디서(IP·브라우저) 무엇을(event) 했는지.
--     현재 event = 'login'(카카오 로그인 성공), 'admin_area_entry'(관리자 화면 진입).
--     서버(service_role)만 쓰고, 슈퍼관리자만 읽는다. 2년이 지나면 지운다(기준의 최소 1년보다 길게).
--     user_id에 외래키를 걸지 않는다 — 계정이 지워져도 기록은 보관기간 동안 남아야 한다.

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
    return v_count;
end;
$$;

revoke all on function public.scrub_withdrawn_login_identity(uuid) from public, anon, authenticated;
grant execute on function public.scrub_withdrawn_login_identity(uuid) to service_role;

create table if not exists public.access_log (
    id          bigint generated always as identity primary key,
    user_id     uuid,
    event       text not null check (char_length(event) between 1 and 60),
    ip          text,
    user_agent  text,
    created_at  timestamptz not null default now()
);

create index if not exists idx_access_log_created on public.access_log (created_at);
create index if not exists idx_access_log_user on public.access_log (user_id, created_at desc);

alter table public.access_log enable row level security;

drop policy if exists "Access log viewable by super admin" on public.access_log;
create policy "Access log viewable by super admin" on public.access_log
    for select using (public.get_current_role() = 'super_admin');

-- INSERT·UPDATE·DELETE 정책은 만들지 않는다: 서버(service_role)만 쓴다. 기록은 고칠 수 없다.
revoke all on public.access_log from anon, authenticated;
grant select on public.access_log to authenticated;

create or replace function public.access_log_retention()
returns interval language sql immutable as $$ select interval '2 years' $$;

create or replace function public.purge_old_access_logs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_count integer;
begin
    delete from public.access_log where created_at < now() - public.access_log_retention();
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

revoke all on function public.purge_old_access_logs() from public, anon, authenticated;
grant execute on function public.purge_old_access_logs() to service_role;
