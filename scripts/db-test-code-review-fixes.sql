-- 마이그 195(코드리뷰 수정 4건) 검증. 로컬 Docker DB 전용. 실행(전부 롤백, 193·194·195를 앞에 붙여 적용):
--   (echo "begin;"; cat supabase/migrations/20260930000193_split_inbound_scan.sql supabase/migrations/20260930000194_split_autoresolve_product.sql supabase/migrations/20260930000195_code_review_fixes.sql scripts/db-test-code-review-fixes.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
    raise notice 'PASS: %', p_name;
end $$;

create or replace function pg_temp.ledger_for_boxes() returns void language sql as $$
    insert into public.stock_ledger (wholesaler_id, product_id, inbound_scan_id, qty_delta, event_type, source_type, source_id)
    select s.wholesaler_id, s.product_id, s.id, s.weight, 'INBOUND', 'inbound_scan', s.id
      from public.inbound_scans s
     where s.wholesaler_id = 'a6a6a6a6-0000-0000-0000-0000000000a1'
       and s.parent_scan_id is null
       and not exists (select 1 from public.stock_ledger l where l.inbound_scan_id = s.id and l.event_type = 'INBOUND');
    select public.recalc_product_stock(id) from public.products where wholesaler_id = 'a6a6a6a6-0000-0000-0000-0000000000a1';
$$;

insert into auth.users (id, email) values ('a6a6a6a6-0000-0000-0000-000000000001', 'review@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values ('a6a6a6a6-0000-0000-0000-000000000001', 'wholesaler', 'A', '010')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name)
    values ('a6a6a6a6-0000-0000-0000-0000000000a1', 'a6a6a6a6-0000-0000-0000-000000000001', '리뷰수정축산', '1110000084', 'A');

-- 수입소 지육(품종·등급 없음, 미국산) 부모 상품 + 박스
insert into public.products (id, wholesaler_id, name, category, subcategory, origin, base_price, unit, stock_quantity, is_active, storage_state) values
 ('a6a6a6a6-0000-0000-0000-0000000000b1','a6a6a6a6-0000-0000-0000-0000000000a1','냉동 수입 지육','소','지육','미국산',0,'kg',0,false,'냉동');
insert into public.inbound_scans (id, wholesaler_id, trace_no, product_id, weight, remaining_weight, unit, scan_type, status) values
 ('a6a6a6a6-0000-0000-0000-0000000000c1','a6a6a6a6-0000-0000-0000-0000000000a1','801000311592','a6a6a6a6-0000-0000-0000-0000000000b1',100,100,'kg','MANUAL','NORMAL');
select pg_temp.ledger_for_boxes();

select set_config('request.jwt.claims', '{"sub":"a6a6a6a6-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

-- 1) 수입소는 품종 없이도 쪼개진다
create temp table r1 as select public.split_inbound_scan('a6a6a6a6-0000-0000-0000-0000000000c1',
    '[{"part":"양지","weight":30},{"part":"양지","weight":20},{"part":"갈비","weight":10}]'::jsonb) as r;
select pg_temp.expect('수입소(품종 없음) 쪼개기 성공, 새 상품 2개(양지·갈비)', (select jsonb_array_length(r -> 'created_products') from r1) = 2);
select pg_temp.expect('수입소 상품은 품종·등급 없이 만들어지고 이름도 어색하지 않다',
    exists (select 1 from public.products where name = '냉동 소 양지' or name = '냉동 양지' or (subcategory = '양지' and breed is null and grade is null and origin = '미국산')));
select pg_temp.expect('같은 부위 두 줄은 한 상품(중복 생성 없음)',
    (select count(*) from public.products where wholesaler_id = 'a6a6a6a6-0000-0000-0000-0000000000a1' and subcategory = '양지') = 1);
select pg_temp.expect('양지 재고 50', (select stock_quantity from public.products where subcategory = '양지' and wholesaler_id = 'a6a6a6a6-0000-0000-0000-0000000000a1') = 50);

-- 2) 두 번째 수입소 박스에서도 기존 상품을 다시 찾아 쓴다(NULL = NULL 비교)
reset role;
insert into public.inbound_scans (id, wholesaler_id, trace_no, product_id, weight, remaining_weight, unit, scan_type, status) values
 ('a6a6a6a6-0000-0000-0000-0000000000c2','a6a6a6a6-0000-0000-0000-0000000000a1','915169500007','a6a6a6a6-0000-0000-0000-0000000000b1',40,40,'kg','MANUAL','NORMAL');
select pg_temp.ledger_for_boxes();
select set_config('request.jwt.claims', '{"sub":"a6a6a6a6-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
create temp table r2 as select public.split_inbound_scan('a6a6a6a6-0000-0000-0000-0000000000c2', '[{"part":"양지","weight":35}]'::jsonb) as r;
select pg_temp.expect('두 번째 수입소 박스는 기존 양지 상품 재사용(새 상품 0)', (select jsonb_array_length(r -> 'created_products') from r2) = 0);

-- 3) 국내산인데 품종을 모르면 여전히 막는다
reset role;
insert into public.products (id, wholesaler_id, name, category, subcategory, origin, base_price, unit, stock_quantity, is_active, storage_state) values
 ('a6a6a6a6-0000-0000-0000-0000000000b2','a6a6a6a6-0000-0000-0000-0000000000a1','냉장 국내 지육(품종없음)','소','지육','국내산',0,'kg',0,false,'냉장');
insert into public.inbound_scans (id, wholesaler_id, trace_no, product_id, weight, remaining_weight, unit, scan_type, status) values
 ('a6a6a6a6-0000-0000-0000-0000000000c3','a6a6a6a6-0000-0000-0000-0000000000a1','002000000011','a6a6a6a6-0000-0000-0000-0000000000b2',50,50,'kg','MANUAL','NORMAL');
select pg_temp.ledger_for_boxes();
select set_config('request.jwt.claims', '{"sub":"a6a6a6a6-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;
select pg_temp.err($q$ select public.split_inbound_scan('a6a6a6a6-0000-0000-0000-0000000000c3', '[{"part":"등심","weight":10}]'::jsonb) $q$) as e \gset
select pg_temp.expect('국내산인데 품종을 모르면 PART_BREED_UNKNOWN', :'e' like '%PART_BREED_UNKNOWN%');

-- 4) 쪼갠 박스의 부위가 부모의 이력조회 부위로 덮어써지지 않는다
reset role;
select public.upsert_master_livestock('801000311592','imported','meatwatch_imported','{}'::jsonb,'수입소','소','양지',null,current_date-5,null,null,'미국',null,null,null,null);
select pg_temp.expect('이력조회가 부위(양지)를 준 번호의 자식 박스(양지 2·갈비 1)에서 갈비는 갈비로 남는다',
    (select count(*) from public.inbound_scans where parent_scan_id = 'a6a6a6a6-0000-0000-0000-0000000000c1' and tag_part = '갈비') = 1);
select pg_temp.expect('이력조회 갱신 뒤에도 자식 박스 부위는 각자 상품의 부위',
    (select count(*) from public.inbound_scans s join public.products p on p.id = s.product_id
      where s.parent_scan_id = 'a6a6a6a6-0000-0000-0000-0000000000c1' and s.tag_part is distinct from p.subcategory) = 0);
select pg_temp.expect('최상위(부모) 박스는 이력조회 부위를 그대로 따른다',
    (select tag_part from public.inbound_scans where id = 'a6a6a6a6-0000-0000-0000-0000000000c1') = '양지');

-- 5) 그림자 집계는 남은 중량 0 박스를 세지 않는다
select set_config('request.jwt.claims', '{"sub":"a6a6a6a6-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.expect('다 쪼개져 잔량 0인 부모는 어느 상품의 박스 수에도 안 잡힌다',
    (select coalesce(sum(sure_boxes + mixed_boxes), 0) from public.shadow_box_stock('a6a6a6a6-0000-0000-0000-0000000000a1') where product_name = '냉동 수입 지육') = 0);
select pg_temp.expect('잔량이 있는 박스(국내 지육 50kg)는 센다',
    (select sure_boxes from public.shadow_box_stock('a6a6a6a6-0000-0000-0000-0000000000a1') where product_name = '냉장 국내 지육(품종없음)') = 1);

-- 6) 입출고 요약에 쪼개기 칸
select pg_temp.expect('요약 카드에 쪼개기 칸이 있고 SPLIT_OUT+SPLIT_IN이 들어간다',
    (select split_qty from public.summarize_stock_ledger('a6a6a6a6-0000-0000-0000-0000000000a1', null, null, null, null))
      = (select coalesce(sum(qty_delta), 0) from public.stock_ledger where wholesaler_id = 'a6a6a6a6-0000-0000-0000-0000000000a1' and event_type in ('SPLIT_OUT', 'SPLIT_IN')));
select pg_temp.expect('입고+출고+조정+손실+쪼개기 = 원장 전체 합(요약이 어느 칸에도 안 빠진다)',
    (select inbound_qty + outbound_qty + adjustment_qty + loss_qty + split_qty from public.summarize_stock_ledger('a6a6a6a6-0000-0000-0000-0000000000a1', null, null, null, null))
      = (select coalesce(sum(qty_delta), 0) from public.stock_ledger where wholesaler_id = 'a6a6a6a6-0000-0000-0000-0000000000a1'));
