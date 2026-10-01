-- 마이그 194(쪼개기에서 부위만 고르면 상품 자동 연결) 검증. 로컬 Docker DB 전용. 실행(전부 롤백):
--   (echo "begin;"; cat supabase/migrations/20260930000193_split_inbound_scan.sql supabase/migrations/20260930000194_split_autoresolve_product.sql scripts/db-test-split-autoresolve.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
    raise notice 'PASS: %', p_name;
end $$;

create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;

insert into auth.users (id, email) values ('f5f5f5f5-0000-0000-0000-000000000001', 'autosplit@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values ('f5f5f5f5-0000-0000-0000-000000000001', 'wholesaler', 'A', '010')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name)
    values ('f5f5f5f5-0000-0000-0000-0000000000a1', 'f5f5f5f5-0000-0000-0000-000000000001', '자동쪼개기', '1110000083', 'A');


-- 실제 입고처럼 박스마다 INBOUND 원장 행이 있어야 재고가 음수가 되지 않는다.
create or replace function pg_temp.ledger_for_boxes() returns void language sql as $$
    insert into public.stock_ledger (wholesaler_id, product_id, inbound_scan_id, qty_delta, event_type, source_type, source_id)
    select s.wholesaler_id, s.product_id, s.id, s.weight, 'INBOUND', 'inbound_scan', s.id
      from public.inbound_scans s
     where s.wholesaler_id = 'f5f5f5f5-0000-0000-0000-0000000000a1'
       and s.parent_scan_id is null
       and not exists (select 1 from public.stock_ledger l where l.inbound_scan_id = s.id and l.event_type = 'INBOUND');
    select public.recalc_product_stock(id) from public.products where wholesaler_id = 'f5f5f5f5-0000-0000-0000-0000000000a1';
$$;

-- 부모 상품(지육): 이 상품 조건이 박스 꼬리표로 복사된다(이력조회 캐시가 없는 번호).
insert into public.products (id, wholesaler_id, name, category, subcategory, origin, grade, breed, sex, bms, storage_state, base_price, unit, stock_quantity, is_active) values
 ('f5f5f5f5-0000-0000-0000-0000000000b1','f5f5f5f5-0000-0000-0000-0000000000a1','냉장 한우 지육 1++(8) 거세','소','지육','국내산','1++','한우','거세','8','냉장',0,'kg',0,false),
 ('f5f5f5f5-0000-0000-0000-0000000000b2','f5f5f5f5-0000-0000-0000-0000000000a1','냉장 한우 지육 혼합','소','지육','국내산',null,'한우',null,null,'냉장',0,'kg',0,false),
 ('f5f5f5f5-0000-0000-0000-0000000000b3','f5f5f5f5-0000-0000-0000-0000000000a1','양 지육','양','지육','국내산',null,null,null,null,null,0,'kg',0,false);
-- 냉장/냉동을 모르는 부모(검증용으로 꼬리표를 비운다)
insert into public.products (id, wholesaler_id, name, category, subcategory, origin, grade, breed, sex, bms, base_price, unit, stock_quantity, is_active) values
 ('f5f5f5f5-0000-0000-0000-0000000000b4','f5f5f5f5-0000-0000-0000-0000000000a1','한우 지육 보관모름','소','지육','국내산',null,'한우',null,null,0,'kg',0,false);

insert into public.inbound_scans (id, wholesaler_id, trace_no, product_id, weight, remaining_weight, unit, scan_type, status) values
 ('f5f5f5f5-0000-0000-0000-0000000000c1','f5f5f5f5-0000-0000-0000-0000000000a1','002000000011','f5f5f5f5-0000-0000-0000-0000000000b1',100,100,'kg','MANUAL','NORMAL'),
 ('f5f5f5f5-0000-0000-0000-0000000000c2','f5f5f5f5-0000-0000-0000-0000000000a1','002000000028','f5f5f5f5-0000-0000-0000-0000000000b2',100,100,'kg','MANUAL','NORMAL'),
 ('f5f5f5f5-0000-0000-0000-0000000000c3','f5f5f5f5-0000-0000-0000-0000000000a1','002000000035','f5f5f5f5-0000-0000-0000-0000000000b3',100,100,'kg','MANUAL','NORMAL'),
 ('f5f5f5f5-0000-0000-0000-0000000000c4','f5f5f5f5-0000-0000-0000-0000000000a1','002000000042','f5f5f5f5-0000-0000-0000-0000000000b4',100,100,'kg','MANUAL','NORMAL');
-- 혼합 로트 흉내: 꼬리표 등급을 '혼합'으로(트리거는 trace_no·product_id가 바뀔 때만 돈다)
update public.inbound_scans set tag_grade = '혼합' where id = 'f5f5f5f5-0000-0000-0000-0000000000c2';

select pg_temp.ledger_for_boxes();
select pg_temp.expect('부모 꼬리표가 상품 조건으로 채워졌다(소·한우·1++·거세·냉장)',
    (select tag_species = '소' and tag_grade = '1++' and tag_sex = '거세' and tag_breed = '한우' and tag_storage_state = '냉장' and tag_bms = '8'
       from public.inbound_scans where id = 'f5f5f5f5-0000-0000-0000-0000000000c1'));

select set_config('request.jwt.claims', '{"sub":"f5f5f5f5-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

-- 1) 부위만 → 상품 자동 생성(두 줄 같은 부위는 한 상품)
create temp table r1 as select public.split_inbound_scan('f5f5f5f5-0000-0000-0000-0000000000c1',
    '[{"part":"등심","weight":30},{"part":"안심","weight":10},{"part":"등심","weight":20}]'::jsonb) as r;

select pg_temp.expect('상품 2개만 새로 만들어졌다(등심·안심)', (select jsonb_array_length(r -> 'created_products') from r1) = 2);
select pg_temp.expect('상품 이름은 입고 자동 생성과 같은 규칙',
    exists (select 1 from public.products where wholesaler_id = 'f5f5f5f5-0000-0000-0000-0000000000a1' and name = '냉장 한우 등심 1++(8) 거세'));
select pg_temp.expect('새 상품은 판매중지·가격 0·조건이 부모 꼬리표와 같다',
    (select is_active = false and base_price = 0 and category = '소' and breed = '한우' and grade = '1++' and sex = '거세' and bms = '8' and storage_state = '냉장' and origin = '국내산' and subcategory = '등심'
       from public.products where name = '냉장 한우 등심 1++(8) 거세'));
select pg_temp.expect('자식 박스 3개, 등심 재고 50·안심 10',
    (select count(*) from public.inbound_scans where parent_scan_id = 'f5f5f5f5-0000-0000-0000-0000000000c1') = 3
    and (select stock_quantity from public.products where name = '냉장 한우 등심 1++(8) 거세') = 50
    and (select stock_quantity from public.products where name = '냉장 한우 안심 1++(8) 거세') = 10);
select pg_temp.expect('자식 꼬리표 부위는 각자 부위',
    (select count(*) from public.inbound_scans where parent_scan_id = 'f5f5f5f5-0000-0000-0000-0000000000c1' and tag_part = '등심') = 2);

-- 2) 같은 조건 상품이 이미 있으면 새로 안 만든다
reset role;
insert into public.inbound_scans (id, wholesaler_id, trace_no, product_id, weight, remaining_weight, unit, scan_type, status) values
 ('f5f5f5f5-0000-0000-0000-0000000000c5','f5f5f5f5-0000-0000-0000-0000000000a1','002000000059','f5f5f5f5-0000-0000-0000-0000000000b1',50,50,'kg','MANUAL','NORMAL');
select pg_temp.ledger_for_boxes();
select set_config('request.jwt.claims', '{"sub":"f5f5f5f5-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
create temp table r2 as select public.split_inbound_scan('f5f5f5f5-0000-0000-0000-0000000000c5', '[{"part":"등심","weight":40}]'::jsonb) as r;
select pg_temp.expect('기존 상품 재사용(새로 만든 상품 0)', (select jsonb_array_length(r -> 'created_products') from r2) = 0);
select pg_temp.expect('등심 상품이 여전히 하나', (select count(*) from public.products where name = '냉장 한우 등심 1++(8) 거세') = 1);
select pg_temp.expect('재사용한 상품 재고가 합산(90)', (select stock_quantity from public.products where name = '냉장 한우 등심 1++(8) 거세') = 90);

-- 3) 혼합 로트 → 등급 없는 상품
create temp table r3 as select public.split_inbound_scan('f5f5f5f5-0000-0000-0000-0000000000c2', '[{"part":"등심","weight":60}]'::jsonb) as r;
select pg_temp.expect('혼합 로트는 등급 없는 상품("냉장 한우 등심")으로 이어진다',
    (select grade is null and bms is null and sex is null from public.products where name = '냉장 한우 등심'));

-- 4) 실패 케이스(전부 롤백되어야 한다)
select pg_temp.err($q$ select public.split_inbound_scan('f5f5f5f5-0000-0000-0000-0000000000c4', '[{"part":"등심","weight":10}]'::jsonb) $q$) as e \gset
select pg_temp.expect('냉장/냉동을 모르는 박스는 PART_NEEDS_STORAGE', :'e' like '%PART_NEEDS_STORAGE%');

select pg_temp.err($q$ select public.split_inbound_scan('f5f5f5f5-0000-0000-0000-0000000000c3', '[{"part":"등심","weight":10}]'::jsonb) $q$) as e \gset
select pg_temp.expect('소·돼지 외 축종은 PART_AUTORESOLVE_UNSUPPORTED', :'e' like '%PART_AUTORESOLVE_UNSUPPORTED%');

select pg_temp.err($q$ select public.split_inbound_scan('f5f5f5f5-0000-0000-0000-0000000000c4', '[{"part":"  ","weight":10}]'::jsonb) $q$) as e \gset
select pg_temp.expect('부위도 상품도 없는 줄은 INVALID_SPLIT_LINE', :'e' like '%INVALID_SPLIT_LINE%');

select pg_temp.expect('실패한 시도는 박스·상품을 남기지 않는다',
    (select count(*) from public.inbound_scans where parent_scan_id in ('f5f5f5f5-0000-0000-0000-0000000000c3','f5f5f5f5-0000-0000-0000-0000000000c4')) = 0);

reset role;
insert into public.inbound_scans (id, wholesaler_id, trace_no, product_id, weight, remaining_weight, unit, scan_type, status) values
 ('f5f5f5f5-0000-0000-0000-0000000000c6','f5f5f5f5-0000-0000-0000-0000000000a1','002000000066','f5f5f5f5-0000-0000-0000-0000000000b1',50,50,'kg','MANUAL','NORMAL'),
 ('f5f5f5f5-0000-0000-0000-0000000000c7','f5f5f5f5-0000-0000-0000-0000000000a1','002000000073','f5f5f5f5-0000-0000-0000-0000000000b1',50,50,'kg','MANUAL','NORMAL');
select pg_temp.ledger_for_boxes();
select set_config('request.jwt.claims', '{"sub":"f5f5f5f5-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

-- 5) 합계 초과 시, 앞 줄에서 만들던 상품까지 통째로 취소된다
select pg_temp.err($q$ select public.split_inbound_scan('f5f5f5f5-0000-0000-0000-0000000000c6', '[{"part":"갈비","weight":5},{"part":"채끝","weight":99}]'::jsonb) $q$) as e \gset
select pg_temp.expect('초과는 CHILDREN_EXCEED_PARENT', :'e' like '%CHILDREN_EXCEED_PARENT%');
select pg_temp.expect('실패한 줄의 새 상품(갈비·채끝)은 남지 않는다',
    (select count(*) from public.products where wholesaler_id = 'f5f5f5f5-0000-0000-0000-0000000000a1' and subcategory in ('갈비', '채끝')) = 0);

-- 6) 기존 방식(product_id 직접 지정)도 그대로 동작
create temp table r4 as select public.split_inbound_scan('f5f5f5f5-0000-0000-0000-0000000000c7',
    jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where name = '냉장 한우 안심 1++(8) 거세'), 'weight', 7))) as r;
select pg_temp.expect('product_id 직접 지정도 가능', (select (r ->> 'children_weight')::numeric from r4) = 7);
