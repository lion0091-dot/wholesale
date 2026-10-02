-- ====================================================================
-- 204: 크론 실행 기록(cron_runs) — "마지막으로 돈 시각·성공 시각"
--
-- Vercel 크론은 실패해도 재시도하지 않고, 호출이 아예 안 가면 로그도 남지 않는다.
-- Alerts(Observability Plus)는 에러율 급증만 보므로 하루 1번 도는 크론의 실패·누락은 못 잡는다.
-- 그래서 각 크론이 끝날 때 한 줄을 갱신하고, 슈퍼관리자 화면(/admin/cron-health)이
-- "예정 주기보다 오래 성공이 없으면" 빨간 표시를 띄운다.
--
-- 쓰기는 service_role(크론 라우트)만. 조회는 슈퍼관리자만. 개인정보 없음(작업 이름·상태·짧은 메시지).
-- ====================================================================

create table if not exists public.cron_runs (
    job          text primary key check (char_length(job) between 1 and 80),
    last_run_at  timestamptz not null default now(),
    last_ok_at   timestamptz,
    last_status  integer not null,
    last_detail  text
);

alter table public.cron_runs enable row level security;

drop policy if exists "Cron runs viewable by super admin" on public.cron_runs;
create policy "Cron runs viewable by super admin" on public.cron_runs
    for select using (public.get_current_role() = 'super_admin');

revoke all on public.cron_runs from anon, authenticated;
grant select on public.cron_runs to authenticated;
