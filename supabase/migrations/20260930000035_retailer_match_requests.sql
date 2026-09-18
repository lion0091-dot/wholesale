-- 고객사(식당) "입점 희망" 리드 수집. 알고리즘 매칭이 아니라, 대문에서 신청을 받으면
-- 관리자가 이 목록을 보고 적합해 보이는 공급사에 직접(전화 등 오프라인으로) 의뢰하는
-- 구조다 — 그래서 "매칭됨" 상태도 자동 판정이 아니라 관리자가 수동으로 표시한다.
--
-- 로그인 없이 대문에서 누구나 제출할 수 있어야 하므로 INSERT는 인증 여부와 무관하게
-- 허용한다(anon 포함). 조회/상태 관리는 super_admin 전용 — 개인정보(연락처)가 담긴
-- 리드라 공급사에게는 공개하지 않는다(공급사 접촉은 관리자가 오프라인으로 수행).
create table public.retailer_match_requests (
    id                  uuid primary key default gen_random_uuid(),
    restaurant_name     text not null,
    contact_name        text not null,
    contact_phone       text not null,
    region              text,
    desired_category    text,
    monthly_volume_hint text,
    memo                text,
    status              text not null default 'pending' check (status in ('pending', 'contacted', 'matched', 'closed')),
    admin_note          text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

alter table public.retailer_match_requests enable row level security;

create policy "Retailer match requests insertable by anyone" on public.retailer_match_requests
    for insert
    with check (true);

create policy "Retailer match requests viewable by super_admin" on public.retailer_match_requests
    for select using (public.get_current_role() = 'super_admin');

create policy "Retailer match requests updatable by super_admin" on public.retailer_match_requests
    for update
    using (public.get_current_role() = 'super_admin')
    with check (public.get_current_role() = 'super_admin');
