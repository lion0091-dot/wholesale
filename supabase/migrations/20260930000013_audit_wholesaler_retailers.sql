-- 여신(credit_limit/outstanding_balance) 변경 이력 추적. apply_credit_order()/
-- record_settlement() 등 SECURITY DEFINER 함수를 통한 변경도 auth.uid()가 그
-- 함수를 호출한 세션 사용자로 남아있어 트리거에서 정상적으로 잡힌다.
create trigger trg_wholesaler_retailers_audit
    after insert or update or delete on public.wholesaler_retailers
    for each row execute function public.log_audit_event();
