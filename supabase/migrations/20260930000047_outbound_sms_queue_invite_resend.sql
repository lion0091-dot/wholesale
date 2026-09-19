-- 초청장 문자 큐(retailer_invite)의 재발송 허용.
--
-- 기존 idx_outbound_sms_queue_invite는 (wholesaler_id, retailer_id)에 상태 무관 영구
-- 유니크였다 — 한 번 큐에 들어간 거래처는 보냈든 안 보냈든 다시는 큐에 못 들어갔다.
-- "거래처 전체 큐에 채우기" 버튼(actions.ts의 generateInviteSmsQueueAction)은 이제 신규
-- 거래처 + "마지막 발송(sent_at)으로부터 30일 지난" 거래처를 함께 채운다 — 이 인덱스를
-- status='pending'로 좁혀야 sent 상태인 거래처 옆에 재발송용 새 pending 행을 하나 더
-- 만들 수 있다(별도 재발송 액션을 두지 않고 "채우기" 버튼 자체가 재발송 대상도 자동으로
-- 골라내는 방식으로 확정 — 2026-09-19).
--
-- 청구서(billing_invoice)는 invoice_id 자체가 매달 새 행이라 이 문제가 없어(다음 달 새
-- invoice_id로 자연 재발송) idx_outbound_sms_queue_invoice는 건드리지 않는다.
drop index public.idx_outbound_sms_queue_invite;

create unique index idx_outbound_sms_queue_invite_pending
    on public.outbound_sms_queue(wholesaler_id, retailer_id)
    where message_type = 'retailer_invite' and status = 'pending';
