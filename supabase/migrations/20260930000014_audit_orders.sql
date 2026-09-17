-- 주문 상태 변화(접수→확정→배송→완료/취소 등) 이력 추적.
create trigger trg_orders_audit
    after insert or update or delete on public.orders
    for each row execute function public.log_audit_event();
