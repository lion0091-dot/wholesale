-- 상품 등록/수정/삭제(가격·재고·시크릿딜·판매상태 변경 포함) 이력 추적.
create trigger trg_products_audit
    after insert or update or delete on public.products
    for each row execute function public.log_audit_event();
