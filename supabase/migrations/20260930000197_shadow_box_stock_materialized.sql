-- 197: shadow_box_stock 통계 없을 때의 성능 — 196은 ANALYZE 이후엔 80ms지만, 대량 입고 직후(통계 없음)에는
-- 박스 집계 CTE(combos)가 상품마다 다시 계산돼(실행계획 GroupAggregate loops=상품 수) 박스 5,000·상품 50에서 2.5초였다.
-- CTE를 AS MATERIALIZED로 고정해 한 번만 계산한다(통계 없음 2,489ms → 41ms, 통계 있음 79ms → 24ms). 결과 값은 196과 같다.

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
    with combos as materialized (
        select s.tag_species, s.tag_part, s.tag_origin, s.tag_grade, s.tag_sex, s.tag_bms, s.tag_breed, s.tag_storage_state,
               count(*) as boxes, sum(s.remaining_weight) as weight
          from public.inbound_scans s
         where s.wholesaler_id = p_wholesaler_id and s.status = 'NORMAL' and s.remaining_weight > 0
         group by s.tag_species, s.tag_part, s.tag_origin, s.tag_grade, s.tag_sex, s.tag_bms, s.tag_breed, s.tag_storage_state
    ),
    legacy as materialized (
        -- 옛 방식: product_id가 이 상품인 박스의 남은 중량
        select s.product_id, sum(s.remaining_weight) as weight
          from public.inbound_scans s
         where s.wholesaler_id = p_wholesaler_id and s.status = 'NORMAL' and s.remaining_weight > 0
         group by s.product_id
    ),
    matched as materialized (
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
