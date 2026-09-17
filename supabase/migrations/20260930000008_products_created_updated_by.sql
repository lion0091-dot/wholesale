-- 여러 직원이 같은 백오피스를 쓸 수 있게 된 뒤([[staff-invite-feature]])로도
-- products/custom_prices/orders에 "누가" 등록·수정했는지 기록하는 컬럼이 없었다.
-- created_at/updated_at 타임스탬프만 있고 행위자는 전혀 안 남았음.
--
-- 서버 액션 코드를 하나도 안 건드리기 위해 DB가 자동으로 채우게 한다:
-- created_by는 컬럼 기본값(auth.uid()), updated_by는 BEFORE UPDATE 트리거.
-- 이 트리거 함수는 products/custom_prices/orders가 공용으로 쓴다.
create or replace function public.set_updated_by()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
    new.updated_by := auth.uid();
    return new;
end;
$$;

alter table public.products
    add column created_by uuid references auth.users(id) on delete set null default auth.uid(),
    add column updated_by uuid references auth.users(id) on delete set null default auth.uid();

comment on column public.products.created_by is '상품을 최초 등록한 계정(auth.uid()) — 컬럼 기본값으로 자동 기록.';
comment on column public.products.updated_by is '마지막으로 수정한 계정 — BEFORE UPDATE 트리거(trg_products_set_updated_by)로 자동 갱신.';

create trigger trg_products_set_updated_by
    before update on public.products
    for each row execute function public.set_updated_by();
