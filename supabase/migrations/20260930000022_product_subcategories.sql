-- 축종(product_categories) 하위에 부위(product_subcategories)를 추가한다.
-- 지금까지는 "등심", "삼겹살" 같은 부위가 products.name 자유 텍스트에만 섞여 들어가
-- 바이어가 부위별로 필터링할 수 없었다 (참고: product-category-hierarchy-todo 메모).
create table public.product_subcategories (
    id          uuid primary key default gen_random_uuid(),
    category_id uuid not null references public.product_categories(id) on delete cascade,
    name        text not null,
    sort_order  integer not null default 0,
    created_at  timestamptz not null default now(),
    unique (category_id, name)
);

alter table public.product_subcategories enable row level security;

create policy "Product subcategories viewable by authenticated" on public.product_subcategories
    for select
    to authenticated
    using (true);

create policy "Product subcategories manageable by super admin" on public.product_subcategories
    for all
    using (public.get_current_role() = 'super_admin')
    with check (public.get_current_role() = 'super_admin');

-- products.category와 동일하게 FK가 아닌 텍스트로 저장한다 (기존 컨벤션 유지, 부위 없는
-- 기존 상품도 그대로 두기 위해 nullable).
alter table public.products add column subcategory text;

-- 축종별 기본 부위 시드 — 관리자가 /admin/categories에서 추가/삭제 가능.
insert into public.product_subcategories (category_id, name, sort_order)
select c.id, v.name, v.sort_order
from public.product_categories c
join (
    values
        ('소', '안심', 1), ('소', '등심', 2), ('소', '채끝', 3), ('소', '갈비', 4),
        ('소', '양지', 5), ('소', '사태', 6), ('소', '우삼겹', 7), ('소', '차돌박이', 8),
        ('소', '다짐육', 9),
        ('돼지', '삼겹살', 1), ('돼지', '목살', 2), ('돼지', '앞다리살', 3), ('돼지', '뒷다리살', 4),
        ('돼지', '안심', 5), ('돼지', '등심', 6), ('돼지', '갈비', 7), ('돼지', '항정살', 8),
        ('돼지', '가브리살', 9),
        ('닭/오리', '통닭', 1), ('닭/오리', '다리살', 2), ('닭/오리', '가슴살', 3),
        ('닭/오리', '날개', 4), ('닭/오리', '안심', 5), ('닭/오리', '오리훈제', 6),
        ('양', '양갈비', 1), ('양', '양다리', 2), ('양', '양등심', 3), ('양', '통양', 4),
        ('가공육', '소시지', 1), ('가공육', '햄', 2), ('가공육', '베이컨', 3),
        ('가공육', '육포', 4), ('가공육', '순대', 5)
) as v(category_name, name, sort_order) on v.category_name = c.name;
