-- 플랫폼 구독료 청구/수납 관리. 지금까지 구독료는 항상 "그때그때 실시간 재계산"이었는데
-- (computeMonthlyFee가 현재 실발주 거래처 수를 그대로 씀), 그 방식으로는 지난달 발주가
-- 나중에 취소돼도 청구액이 소급으로 흔들려서 "수납 관리"의 기준으로 쓸 수 없다.
--
-- 잠긴 설계 결정(2026-09-19):
-- - 매달 1일 새벽 크론(app/api/cron/finalize-subscription-invoices)이 "방금 끝난 달"의
--   청구액을 확정(스냅샷)해서 이 표에 한 번만 기록한다. 이후로는 절대 재계산하지 않는다
--   — 발주 취소 등으로 원본 데이터가 바뀌어도 이미 확정된 청구서는 그대로 유지된다.
-- - 확정 시점 계산엔 그 달의 일할 계산(billing_starts_at 기준)과 이벤트 할인
--   (platform_events)까지 전부 반영한 "실제 청구액"을 저장한다(amount). 할인/일할
--   적용 전 정가(full_month_fee)도 같이 남겨서 화면에서 비교 표시할 수 있게 한다.
-- - 수납 여부(status)는 super_admin이 화면에서 수동으로 바꾸거나, 엑셀(CSV) 일괄
--   업로드로 반영한다 — 자동 결제 연동은 없다(docs/platform-subscription-billing.md와
--   같은 원칙, "결제 자동화는 아직 미정").
create table public.platform_subscription_invoices (
    id                    uuid primary key default gen_random_uuid(),
    wholesaler_id         uuid not null references public.wholesalers(id) on delete cascade,
    -- 항상 그 달 1일(KST 기준 달력월)로 저장 — 조회 시 date_trunc 없이 바로 비교 가능.
    billing_month         date not null,
    billed_retailer_count integer not null,
    full_month_fee        numeric not null,
    amount                numeric not null,
    status                text not null default 'unpaid' check (status in ('unpaid', 'paid')),
    paid_at               timestamptz,
    collected_by          uuid references auth.users(id) on delete set null,
    memo                  text,
    created_at            timestamptz not null default now(),
    unique (wholesaler_id, billing_month)
);

comment on column public.platform_subscription_invoices.billing_month is '그 청구월의 1일(KST 달력월 기준). 예: 2026-09-01 = 2026년 9월분.';
comment on column public.platform_subscription_invoices.amount is '일할 계산·이벤트 할인까지 반영한 확정 청구액. 확정 이후 절대 재계산하지 않는다.';
comment on column public.platform_subscription_invoices.collected_by is '수납 처리(완납 표시)한 super_admin 계정.';

create index idx_platform_subscription_invoices_month on public.platform_subscription_invoices(billing_month);

alter table public.platform_subscription_invoices enable row level security;

create policy "Subscription invoices viewable by super_admin" on public.platform_subscription_invoices
    for select using (public.get_current_role() = 'super_admin');

create policy "Subscription invoices updatable by super_admin" on public.platform_subscription_invoices
    for update
    using (public.get_current_role() = 'super_admin')
    with check (public.get_current_role() = 'super_admin');

-- INSERT는 크론이 service_role로 수행하므로(RLS 우회) 별도 authenticated INSERT 정책은
-- 두지 않는다 — 화면에서 청구서를 직접 만드는 경로는 없고 확정만 크론이 담당한다.
