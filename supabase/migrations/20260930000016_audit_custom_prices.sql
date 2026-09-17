-- 거래처별 맞춤(VIP) 단가 등록/수정/삭제 이력 추적.
create trigger trg_custom_prices_audit
    after insert or update or delete on public.custom_prices
    for each row execute function public.log_audit_event();
