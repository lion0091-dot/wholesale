-- 196: shadow_box_stock 성능 — 박스 5,000개·상품 50개 기준 2.2초(재고 보기를 열 때마다).
-- 원인: 상품 × 박스를 하나씩 짝지어 조건 비교를 25만 번 했다. 박스를 꼬리표 조합별로 먼저 묶으면(보통 수십~수백 조합)
-- 비교가 상품 × 조합으로 줄어든다. 결과 값은 옛 함수와 같다(양방향 비교 테스트: scripts/db-test-shadow-box-stock-perf.sql).

create or replace function public.shadow_box_stock(p_wholesaler_id uuid)
returns table(
    product_id uuid, product_name text, unit text,
    ledger_stock numeric,
    sure_weight numeric,
    sure_boxes integer,
    mixed_weight numeric,
    mixed_boxes integer,
    legacy_weight numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with combos as (
        select s.tag_species, s.tag_part, s.tag_origin, s.tag_grade, s.tag_sex, s.tag_bms, s.tag_breed, s.tag_storage_state,
               count(*) as boxes, sum(s.remaining_weight) as weight
          from public.inbound_scans s
         where s.wholesaler_id = p_wholesaler_id and s.status = 'NORMAL' and s.remaining_weight > 0
         group by s.tag_species, s.tag_part, s.tag_origin, s.tag_grade, s.tag_sex, s.tag_bms, s.tag_breed, s.tag_storage_state
    ),
    legacy as (
        -- 옛 방식: product_id가 이 상품인 박스의 남은 중량
        select s.product_id, sum(s.remaining_weight) as weight
          from public.inbound_scans s
         where s.wholesaler_id = p_wholesaler_id and s.status = 'NORMAL' and s.remaining_weight > 0
         group by s.product_id
    ),
    matched as (
        select p.id as product_id, c.boxes, c.weight,
               public.box_matches_product(
                   p.category, p.subcategory, p.origin, p.grade, p.sex, p.bms, p.breed, p.storage_state,
                   c.tag_species, c.tag_part, c.tag_origin, c.tag_grade, c.tag_sex, c.tag_bms, c.tag_breed, c.tag_storage_state
               ) as k
          from public.products p
          cross join combos c
         where p.wholesaler_id = p_wholesaler_id
    ),
    agg as (
        select m.product_id,
               coalesce(sum(m.weight) filter (where m.k = 'sure'), 0) as sure_weight,
               coalesce(sum(m.boxes) filter (where m.k = 'sure'), 0) as sure_boxes,
               coalesce(sum(m.weight) filter (where m.k = 'mixed'), 0) as mixed_weight,
               coalesce(sum(m.boxes) filter (where m.k = 'mixed'), 0) as mixed_boxes
          from matched m
         group by m.product_id
    )
    select p.id, p.name, p.unit, p.stock_quantity,
           coalesce(a.sure_weight, 0), coalesce(a.sure_boxes, 0)::integer,
           coalesce(a.mixed_weight, 0), coalesce(a.mixed_boxes, 0)::integer,
           coalesce(l.weight, 0)
      from public.products p
      left join agg a on a.product_id = p.id
      left join legacy l on l.product_id = p.id
     where p.wholesaler_id = p_wholesaler_id
       and public.can_access_wholesaler(p_wholesaler_id)
     order by p.name;
$$;
