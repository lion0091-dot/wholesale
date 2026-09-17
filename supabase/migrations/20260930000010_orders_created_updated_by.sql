-- products/custom_prices와 동일한 이유(20260930000008 참고). orders는 주문 생성이
-- 바이어 세션에서 일어나므로 created_by는 "누가 주문했는지"(바이어), updated_by는
-- 이후 상태 변경 시점의 계정(대개 공급사 직원)을 각각 자연스럽게 기록하게 된다.
alter table public.orders
    add column created_by uuid references auth.users(id) on delete set null default auth.uid(),
    add column updated_by uuid references auth.users(id) on delete set null default auth.uid();

comment on column public.orders.created_by is '주문을 생성한 계정(auth.uid(), 통상 바이어) — 컬럼 기본값으로 자동 기록.';
comment on column public.orders.updated_by is '마지막으로 상태를 변경한 계정(통상 공급사 직원) — BEFORE UPDATE 트리거로 자동 갱신.';

create trigger trg_orders_set_updated_by
    before update on public.orders
    for each row execute function public.set_updated_by();
