-- products와 동일한 이유(20260930000008 참고) — custom_prices도 누가 맞춤단가를
-- 등록/수정했는지 기록이 없었다. 같은 공용 트리거 함수(set_updated_by)를 재사용한다.
alter table public.custom_prices
    add column created_by uuid references auth.users(id) on delete set null default auth.uid(),
    add column updated_by uuid references auth.users(id) on delete set null default auth.uid();

comment on column public.custom_prices.created_by is '맞춤단가를 최초 등록한 계정(auth.uid()) — 컬럼 기본값으로 자동 기록.';
comment on column public.custom_prices.updated_by is '마지막으로 수정한 계정 — BEFORE UPDATE 트리거로 자동 갱신.';

create trigger trg_custom_prices_set_updated_by
    before update on public.custom_prices
    for each row execute function public.set_updated_by();
