-- 상품 카테고리를 코드(product-form-view.tsx의 하드코딩 배열)에서 DB로 옮긴다.
-- 업종 표준 분류라 업체별이 아니라 플랫폼 공용(슈퍼관리자 관리)으로 둔다.
create table public.product_categories (
    id         uuid primary key default gen_random_uuid(),
    name       text not null unique,
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
);

alter table public.product_categories enable row level security;

-- 모든 로그인 사용자(공급사 상품 등록 폼)가 읽을 수 있어야 한다.
create policy "Product categories viewable by authenticated" on public.product_categories
    for select
    to authenticated
    using (true);

-- 추가/수정/삭제는 슈퍼관리자만.
create policy "Product categories manageable by super admin" on public.product_categories
    for all
    using (public.get_current_role() = 'super_admin')
    with check (public.get_current_role() = 'super_admin');

-- 기존 하드코딩 목록을 그대로 이관 — 기존 상품 데이터와의 연속성 유지.
insert into public.product_categories (name, sort_order) values
    ('소', 1), ('돼지', 2), ('닭/오리', 3), ('양', 4), ('가공육', 5);
