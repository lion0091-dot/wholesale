-- 198: 재고 보기 트리용 박스 집계 — 지금은 화면이 박스를 최대 5,000개까지 1,000개씩 5번 읽어 JS에서 센다
-- (5회 순차 조회, 5,000개를 넘으면 합계가 실제보다 작게 나옴). 꼬리표 조합별로 DB에서 한 번에 묶어 돌려준다.
-- 조건은 shadow_box_stock과 같다(NORMAL·남은 중량 > 0). 권한은 can_access_wholesaler.
create or replace function public.stock_box_combos(p_wholesaler_id uuid)
returns table(
    tag_species text, tag_part text, tag_origin text, tag_grade text, tag_sex text, tag_bms text, tag_storage_state text,
    boxes bigint, weight numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select s.tag_species, s.tag_part, s.tag_origin, s.tag_grade, s.tag_sex, s.tag_bms, s.tag_storage_state,
           count(*), sum(s.remaining_weight)
      from public.inbound_scans s
     where s.wholesaler_id = p_wholesaler_id
       and s.status = 'NORMAL'
       and s.remaining_weight > 0
       and public.can_access_wholesaler(p_wholesaler_id)
     group by s.tag_species, s.tag_part, s.tag_origin, s.tag_grade, s.tag_sex, s.tag_bms, s.tag_storage_state;
$$;

revoke all on function public.stock_box_combos(uuid) from public, anon;
grant execute on function public.stock_box_combos(uuid) to authenticated, service_role;
