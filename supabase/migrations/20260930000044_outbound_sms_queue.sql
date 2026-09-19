-- 문자(SMS) 일괄발송 대기열. 두 발신 주체를 한 테이블에 모아 관리한다:
--   - billing_invoice: 플랫폼(super_admin)이 공급사에게 보내는 구독료 청구 문자
--   - retailer_invite: 공급사가 자기 거래처(소매)에게 보내는 미니샵 초대 문자
--
-- 잠긴 설계 결정(2026-09-19):
-- - "체크박스 선택 + 일괄발송 버튼"으로 여러 건을 한 번에 실제 발송하려면 서버가 호출하는
--   진짜 SMS API(알리고/Solapi 등)가 필요하다. 아직 그런 벤더 계약이 없으므로, 이 테이블과
--   화면은 먼저 만들어두고 "일괄발송" 버튼은 실제 발송 대신 계약 안내 문구만 보여준다
--   (lib/notifications/sms-queue.ts의 BULK_SMS_NOT_CONFIGURED_NOTICE). 그래서 status는
--   지금은 사실상 항상 'pending'이고, 벤더 연동 후에만 'sent'로 바뀌게 된다.
-- - message_body는 생성 시점에 완성된 문자열을 스냅샷으로 저장한다(발송 시점에 다시
--   조립하지 않음) — 청구/초대 문구가 나중에 바뀌어도 이미 큐에 들어간 대기 건은 생성 당시
--   안내 그대로 나가야 한다.
-- - 같은 청구서/같은 거래처로 중복 행이 쌓이지 않도록 부분 유니크 인덱스로 멱등하게
--   생성한다(재생성 버튼을 여러 번 눌러도 안전).
create table public.outbound_sms_queue (
    id              uuid primary key default gen_random_uuid(),
    message_type    text not null check (message_type in ('billing_invoice', 'retailer_invite')),
    wholesaler_id   uuid not null references public.wholesalers(id) on delete cascade,
    retailer_id     uuid references public.retailers(id) on delete cascade,
    invoice_id      uuid references public.platform_subscription_invoices(id) on delete cascade,
    recipient_name  text not null,
    recipient_phone text not null,
    message_body    text not null,
    status          text not null default 'pending' check (status in ('pending', 'sent')),
    created_by      uuid references auth.users(id) on delete set null,
    created_at      timestamptz not null default now(),
    sent_at         timestamptz,
    constraint outbound_sms_queue_reference_matches_type check (
        (message_type = 'billing_invoice' and invoice_id is not null and retailer_id is null)
        or
        (message_type = 'retailer_invite' and retailer_id is not null and invoice_id is null)
    )
);

comment on column public.outbound_sms_queue.message_body is
    '생성 시점에 완성한 문자 본문 스냅샷. 발송 시 재조립하지 않는다.';

create unique index idx_outbound_sms_queue_invoice
    on public.outbound_sms_queue(invoice_id)
    where message_type = 'billing_invoice';

create unique index idx_outbound_sms_queue_invite
    on public.outbound_sms_queue(wholesaler_id, retailer_id)
    where message_type = 'retailer_invite';

create index idx_outbound_sms_queue_wholesaler on public.outbound_sms_queue(wholesaler_id, message_type);

alter table public.outbound_sms_queue enable row level security;

-- 청구서 큐(billing_invoice)는 super_admin 전용, 초청장 큐(retailer_invite)는 해당
-- 공급사 본인/소속 직원 전용 — 20260930000024에서 추가한 is_org_staff_of_wholesaler를 그대로 재사용한다.
create policy "Outbound sms queue viewable by owner" on public.outbound_sms_queue
    for select using (
        (message_type = 'billing_invoice' and public.get_current_role() = 'super_admin')
        or (
            message_type = 'retailer_invite'
            and (
                wholesaler_id = public.get_current_wholesaler_id()
                or public.is_org_staff_of_wholesaler(wholesaler_id)
            )
        )
    );

create policy "Outbound sms queue insertable by owner" on public.outbound_sms_queue
    for insert with check (
        (message_type = 'billing_invoice' and public.get_current_role() = 'super_admin')
        or (
            message_type = 'retailer_invite'
            and (
                wholesaler_id = public.get_current_wholesaler_id()
                or public.is_org_staff_of_wholesaler(wholesaler_id)
            )
        )
    );

-- status를 'sent'로 바꾸는 실제 발송 연동이 아직 없어 지금은 쓰이지 않지만, 벤더 연동
-- 시 화면 코드만 바꾸면 되도록 정책을 미리 열어둔다.
create policy "Outbound sms queue updatable by owner" on public.outbound_sms_queue
    for update using (
        (message_type = 'billing_invoice' and public.get_current_role() = 'super_admin')
        or (
            message_type = 'retailer_invite'
            and (
                wholesaler_id = public.get_current_wholesaler_id()
                or public.is_org_staff_of_wholesaler(wholesaler_id)
            )
        )
    );
