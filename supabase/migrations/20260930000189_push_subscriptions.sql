-- 189: 웹푸시 구독 — 공급사 직원이 자기 폰·PC 브라우저에서 "알림 받기"를 켜면 그 브라우저의 푸시 주소를 보관한다.
--
-- 2026-10-01 사장님 결정: 공급사용 알림 4종(신규 주문·주문 수정·취소 요청·여신 초과 거절)은 알림톡(대표 1명 번호)
-- 대신 웹푸시(켠 직원 전원)로 보낸다. 켠 사람이 하나도 없는 업체만 지금처럼 알림톡.
--
-- 한 행 = 브라우저 하나(endpoint가 곧 주소라 유일). 같은 사람이 폰·PC 두 곳에서 켜면 두 행.
-- 발송은 서버(service_role)만 한다 — 세션은 자기 행을 넣고·보고·지우는 것까지만.

create table if not exists public.push_subscriptions (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references auth.users(id) on delete cascade,
    wholesaler_id uuid not null references public.wholesalers(id) on delete cascade,
    endpoint      text not null unique check (char_length(endpoint) between 1 and 2048),
    p256dh        text not null check (char_length(p256dh) between 1 and 512),
    auth          text not null check (char_length(auth) between 1 and 256),
    user_agent    text check (user_agent is null or char_length(user_agent) <= 512),
    created_at    timestamptz not null default now(),
    last_used_at  timestamptz
);

create index if not exists idx_push_subscriptions_wholesaler on public.push_subscriptions (wholesaler_id);
create index if not exists idx_push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "Push subscriptions: own rows" on public.push_subscriptions;
create policy "Push subscriptions: own rows" on public.push_subscriptions
    for select to authenticated
    using (user_id = auth.uid());

-- 넣을 때 "내 계정 + 내가 실제로 속한 업체"만. 업체 소속 판정은 기존 헬퍼(대표 본인 또는 조직 직원).
drop policy if exists "Push subscriptions: insert own" on public.push_subscriptions;
create policy "Push subscriptions: insert own" on public.push_subscriptions
    for insert to authenticated
    with check (
        user_id = auth.uid()
        and (
            wholesaler_id = public.get_current_wholesaler_id()
            or public.is_org_staff_of_wholesaler(wholesaler_id)
        )
    );

drop policy if exists "Push subscriptions: update own" on public.push_subscriptions;
create policy "Push subscriptions: update own" on public.push_subscriptions
    for update to authenticated
    using (user_id = auth.uid())
    with check (
        user_id = auth.uid()
        and (
            wholesaler_id = public.get_current_wholesaler_id()
            or public.is_org_staff_of_wholesaler(wholesaler_id)
        )
    );

drop policy if exists "Push subscriptions: delete own" on public.push_subscriptions;
create policy "Push subscriptions: delete own" on public.push_subscriptions
    for delete to authenticated
    using (user_id = auth.uid());

revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
