-- 192: 재고 재설계 — 박스 합산 "그림자" 조회(읽기 전용). **동작 변화 없음.**
-- docs/stock-redesign-boxes-and-conditions.md §2-2·§2-3·§3-3. recalc_product_stock·apply_order_shipment·stock_quantity는 건드리지 않는다.
-- 상품 조건(NULL = 상관없음)에 박스 꼬리표가 맞는지 판정하고, 상품별로 "확실한 것 / 열어봐야 아는 것(등급 혼합)"을 집계해
-- 지금 원장 기반 stock_quantity와 나란히 보여준다. 재고 화면(트리)·전환 전 비교가 이 함수를 쓴다.

-- 상품 조건 vs 박스 꼬리표. 'sure' = 전부 만족, 'mixed' = 등급 조건만 혼합 박스에 걸리고 나머지는 만족, null = 불일치.
-- 조건이 있는데 꼬리표가 모름(null)이면 불일치(모르는 것을 확실한 재고로 세지 않는다).
create or replace function public.box_matches_product(
    p_cat text, p_part text, p_origin text, p_grade text, p_sex text, p_bms text, p_breed text, p_storage text,
    t_species text, t_part text, t_origin text, t_grade text, t_sex text, t_bms text, t_breed text, t_storage text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when (
                (nullif(btrim(coalesce(p_cat, '')), '')     is null or p_cat     = t_species)
            and (nullif(btrim(coalesce(p_part, '')), '')    is null or p_part    = t_part)
            and (nullif(btrim(coalesce(p_origin, '')), '')  is null or p_origin  = t_origin)
            and (nullif(btrim(coalesce(p_sex, '')), '')     is null or p_sex     = t_sex)
            and (nullif(btrim(coalesce(p_bms, '')), '')     is null or p_bms     = t_bms)
            and (nullif(btrim(coalesce(p_breed, '')), '')   is null or p_breed   = t_breed)
            and (nullif(btrim(coalesce(p_storage, '')), '') is null or p_storage = t_storage)
        ) is not true then null
        when nullif(btrim(coalesce(p_grade, '')), '') is null then 'sure'
        when t_grade = '혼합' then 'mixed'
        when p_grade = t_grade then 'sure'
        else null
    end;
$$;

revoke all on function public.box_matches_product(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.box_matches_product(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) to authenticated, service_role;

-- 상품별 그림자 재고. 공급사 소속·권한 검사는 can_access_wholesaler(NULL 비교 금지 규칙).
create or replace function public.shadow_box_stock(p_wholesaler_id uuid)
returns table(
    product_id uuid, product_name text, unit text,
    ledger_stock numeric,        -- 지금 products.stock_quantity(원장 합)
    sure_weight numeric,         -- 조건 전부 만족하는 NORMAL 박스 남은 중량 합
    sure_boxes integer,
    mixed_weight numeric,        -- 등급만 혼합이라 열어봐야 아는 박스(재고에 안 넣음)
    mixed_boxes integer,
    legacy_weight numeric        -- 옛 방식: product_id가 이 상품인 NORMAL 박스 남은 중량 합
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select p.id, p.name, p.unit, p.stock_quantity,
           coalesce(sum(s.remaining_weight) filter (where m.k = 'sure'), 0),
           (count(s.id) filter (where m.k = 'sure'))::integer,
           coalesce(sum(s.remaining_weight) filter (where m.k = 'mixed'), 0),
           (count(s.id) filter (where m.k = 'mixed'))::integer,
           coalesce((select sum(l.remaining_weight) from public.inbound_scans l
                      where l.product_id = p.id and l.status = 'NORMAL'), 0)
      from public.products p
      left join public.inbound_scans s
             on s.wholesaler_id = p.wholesaler_id and s.status = 'NORMAL'
      left join lateral (
            select public.box_matches_product(
                p.category, p.subcategory, p.origin, p.grade, p.sex, p.bms, p.breed, p.storage_state,
                s.tag_species, s.tag_part, s.tag_origin, s.tag_grade, s.tag_sex, s.tag_bms, s.tag_breed, s.tag_storage_state
            ) as k
      ) m on true
     where p.wholesaler_id = p_wholesaler_id
       and public.can_access_wholesaler(p_wholesaler_id)
     group by p.id, p.name, p.unit, p.stock_quantity
     order by p.name;
$$;

revoke all on function public.shadow_box_stock(uuid) from public;
grant execute on function public.shadow_box_stock(uuid) to authenticated, service_role;
