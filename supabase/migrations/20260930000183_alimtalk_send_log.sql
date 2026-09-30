-- 183: 알림톡 발송 로그(alimtalk_send_log) 신설 — 플랫폼 대표 채널 발송비 안분 청구 근거 (사장님 결정: 안분)
--
-- 약관 제5조 5~7항: 입점 승인 후 3개월은 플랫폼 부담, 이후 대표 채널 총 발송비를 공급사별 접수 건수 비율로 안분.
-- 기록하는 것: 어느 공급사가(wholesaler_id) 어떤 알림을(template_key) 어느 채널로(channel) 언제 보냈고 결과가 어땠는지(status).
-- 기록하지 않는 것: 수신 전화번호·메시지 본문(개인정보가 새로 쌓이지 않게 — 청구에는 건수만 필요).
-- status = 'sent'는 비즈뿌리오가 요청을 "접수"했다는 뜻이지 수신자 도착이 아니다(결과 리포트 조회는 미구현).
--   → messagekey·refkey를 함께 남겨 나중에 리포트 조회·청구서 대조에 쓴다.
-- wholesaler_id에 외래키를 걸지 않는다 — 공급사 정보가 지워져도 청구 근거 기록은 남아야 한다(access_log와 같은 방식).
-- 서버(service_role)만 쓰고, 슈퍼관리자만 읽는다. 수정·삭제 정책 없음. 개인정보가 없으므로 자동 삭제하지 않는다.

create table if not exists public.alimtalk_send_log (
    id            bigint generated always as identity primary key,
    wholesaler_id uuid not null,
    template_key  text not null check (char_length(template_key) between 1 and 60),
    channel       text not null check (channel in ('platform', 'own')),
    status        text not null check (status in ('sent', 'error', 'not_configured')),
    error_code    integer,
    messagekey    text,
    refkey        text,
    created_at    timestamptz not null default now()
);

create index if not exists idx_alimtalk_send_log_billing
    on public.alimtalk_send_log (created_at, wholesaler_id)
    where channel = 'platform' and status = 'sent';

alter table public.alimtalk_send_log enable row level security;

drop policy if exists "Alimtalk send log viewable by super admin" on public.alimtalk_send_log;
create policy "Alimtalk send log viewable by super admin" on public.alimtalk_send_log
    for select using (public.get_current_role() = 'super_admin');

revoke all on public.alimtalk_send_log from anon, authenticated;
grant select on public.alimtalk_send_log to authenticated;
