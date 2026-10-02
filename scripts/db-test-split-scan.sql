-- 마이그 193(쪼개기) 검증. 로컬 Docker DB 전용. 실행(전부 롤백, 193을 앞에 붙여 적용):
--   (echo "begin;"; cat supabase/migrations/20260930000193_split_inbound_scan.sql scripts/db-test-split-scan.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
    raise notice 'PASS: %', p_name;
end $$;

create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlerrm; end $$;

insert into auth.users (id, email) values ('e4e4e4e4-0000-0000-0000-000000000001', 'split@t.com'), ('e4e4e4e4-0000-0000-0000-000000000002', 'split2@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values
    ('e4e4e4e4-0000-0000-0000-000000000001', 'wholesaler', 'A', '010'),
    ('e4e4e4e4-0000-0000-0000-000000000002', 'wholesaler', 'B', '011')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name) values
    ('e4e4e4e4-0000-0000-0000-0000000000a1', 'e4e4e4e4-0000-0000-0000-000000000001', '쪼개기축산', '1110000081', 'A'),
    ('e4e4e4e4-0000-0000-0000-0000000000a2', 'e4e4e4e4-0000-0000-0000-000000000002', '남의축산', '1110000082', 'B');

insert into public.products (id, wholesaler_id, name, category, subcategory, origin, base_price, unit, stock_quantity, is_active) values
 ('e4e4e4e4-0000-0000-0000-0000000000b1','e4e4e4e4-0000-0000-0000-0000000000a1','한우 지육','소','지육','국내산',0,'kg',0,false),
 ('e4e4e4e4-0000-0000-0000-0000000000b2','e4e4e4e4-0000-0000-0000-0000000000a1','한우 등심','소','등심','국내산',0,'kg',0,false),
 ('e4e4e4e4-0000-0000-0000-0000000000b3','e4e4e4e4-0000-0000-0000-0000000000a1','한우 안심','소','안심','국내산',0,'kg',0,false),
 ('e4e4e4e4-0000-0000-0000-0000000000b4','e4e4e4e4-0000-0000-0000-0000000000a2','남의 등심','소','등심','국내산',0,'kg',0,false),
 ('e4e4e4e4-0000-0000-0000-0000000000b5','e4e4e4e4-0000-0000-0000-0000000000a1','개수상품','소','내장','국내산',0,'개',0,false);

-- 부모 박스: 지육 100kg 입고(원장 INBOUND 포함), 매입가 있음
insert into public.inbound_scans (id, wholesaler_id, trace_no, product_id, weight, remaining_weight, unit, scan_type, status, purchase_unit_price, best_before) values
 ('e4e4e4e4-0000-0000-0000-0000000000c1','e4e4e4e4-0000-0000-0000-0000000000a1','002000000011','e4e4e4e4-0000-0000-0000-0000000000b1',100,100,'kg','MANUAL','NORMAL',10000, current_date + 5);
insert into public.stock_ledger (wholesaler_id, product_id, inbound_scan_id, qty_delta, event_type, source_type, source_id)
values ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000b1','e4e4e4e4-0000-0000-0000-0000000000c1',100,'INBOUND','inbound_scan','e4e4e4e4-0000-0000-0000-0000000000c1');
select public.recalc_product_stock('e4e4e4e4-0000-0000-0000-0000000000b1');

-- 남의 세션: 쪼개기 불가
select set_config('request.jwt.claims', '{"sub":"e4e4e4e4-0000-0000-0000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select pg_temp.err($q$ select public.split_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1', '[{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b4","weight":10}]'::jsonb) $q$) as e \gset
select pg_temp.expect('남의 공급사 박스는 SCAN_NOT_FOUND', :'e' like '%SCAN_NOT_FOUND%');

-- 주인 세션
reset role;
select set_config('request.jwt.claims', '{"sub":"e4e4e4e4-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;

select pg_temp.err($q$ select public.split_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1', '[]'::jsonb) $q$) as e \gset
select pg_temp.expect('줄이 없으면 NO_SPLIT_LINES', :'e' like '%NO_SPLIT_LINES%');

select pg_temp.err($q$ select public.split_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1', '[{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b4","weight":10}]'::jsonb) $q$) as e \gset
select pg_temp.expect('남의 상품으로는 쪼갤 수 없다(PRODUCT_NOT_FOUND)', :'e' like '%PRODUCT_NOT_FOUND%');

select pg_temp.err($q$ select public.split_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1', '[{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b5","weight":10}]'::jsonb) $q$) as e \gset
select pg_temp.expect('단위가 다른 상품은 PRODUCT_UNIT_MISMATCH', :'e' like '%PRODUCT_UNIT_MISMATCH%');

select pg_temp.err($q$ select public.split_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1', '[{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b2","weight":0}]'::jsonb) $q$) as e \gset
select pg_temp.expect('중량 0은 INVALID_SPLIT_LINE', :'e' like '%INVALID_SPLIT_LINE%');

select pg_temp.err($q$ select public.split_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1', '[{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b2","weight":60},{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b3","weight":50}]'::jsonb) $q$) as e \gset
select pg_temp.expect('자식 합이 부모 잔량 초과면 CHILDREN_EXCEED_PARENT', :'e' like '%CHILDREN_EXCEED_PARENT%');

select pg_temp.expect('실패한 시도는 자식 박스를 남기지 않는다', (select count(*) from public.inbound_scans where parent_scan_id is not null) = 0);

-- 정상 쪼개기: 100kg → 등심 40 + 안심 10 + 등심 20 (손실 30)
create temp table res as
select public.split_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1',
  '[{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b2","weight":40},{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b3","weight":10},{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b2","weight":20}]'::jsonb) as r;

select pg_temp.expect('손실 30kg 반환', (select (r ->> 'loss')::numeric from res) = 30);
select pg_temp.expect('부모 잔량 0·split_at·split_loss 30',
    (select remaining_weight = 0 and split_at is not null and split_loss = 30 from public.inbound_scans where id = 'e4e4e4e4-0000-0000-0000-0000000000c1'));
-- 매입금액 컬럼은 직접 조회가 막혀 있다(209) — 이 두 검사만 잠깐 관리 권한으로 읽는다.
reset role;
select pg_temp.expect('부모 매입금액은 그대로(1,000,000)',
    (select purchase_amount = 1000000 from public.inbound_scans where id = 'e4e4e4e4-0000-0000-0000-0000000000c1'));
select pg_temp.expect('자식 3개·같은 이력번호·부모 연결',
    (select count(*) from public.inbound_scans where parent_scan_id = 'e4e4e4e4-0000-0000-0000-0000000000c1' and trace_no = '002000000011' and status = 'NORMAL') = 3);
select pg_temp.expect('자식 매입금액 없음(이중 집계 방지)',
    (select count(*) from public.inbound_scans where parent_scan_id = 'e4e4e4e4-0000-0000-0000-0000000000c1' and purchase_amount is not null) = 0);
set local role authenticated;
select pg_temp.expect('자식이 부모 소비기한 승계',
    (select count(*) from public.inbound_scans where parent_scan_id = 'e4e4e4e4-0000-0000-0000-0000000000c1' and best_before = current_date + 5) = 3);
select pg_temp.expect('자식 꼬리표 부위는 각자 상품의 부위',
    (select count(*) from public.inbound_scans where parent_scan_id = 'e4e4e4e4-0000-0000-0000-0000000000c1' and tag_part = '등심') = 2);

select pg_temp.expect('지육 재고 0', (select stock_quantity from public.products where id = 'e4e4e4e4-0000-0000-0000-0000000000b1') = 0);
select pg_temp.expect('등심 재고 60', (select stock_quantity from public.products where id = 'e4e4e4e4-0000-0000-0000-0000000000b2') = 60);
select pg_temp.expect('안심 재고 10', (select stock_quantity from public.products where id = 'e4e4e4e4-0000-0000-0000-0000000000b3') = 10);
select pg_temp.expect('원장 합계 = 재고(등심)', (select sum(qty_delta) from public.stock_ledger where product_id = 'e4e4e4e4-0000-0000-0000-0000000000b2') = 60);
select pg_temp.expect('SPLIT_OUT 1건·SPLIT_IN 3건',
    (select count(*) from public.stock_ledger where event_type = 'SPLIT_OUT' and wholesaler_id = 'e4e4e4e4-0000-0000-0000-0000000000a1') = 1
    and (select count(*) from public.stock_ledger where event_type = 'SPLIT_IN' and wholesaler_id = 'e4e4e4e4-0000-0000-0000-0000000000a1') = 3);

select pg_temp.err($q$ select public.split_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1', '[{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b2","weight":1}]'::jsonb) $q$) as e \gset
select pg_temp.expect('두 번 쪼개기 불가(ALREADY_SPLIT)', :'e' like '%ALREADY_SPLIT%');

select pg_temp.err($q$ select public.void_inbound_scan('e4e4e4e4-0000-0000-0000-0000000000c1', 'x') $q$) as e \gset
select pg_temp.expect('쪼갠 부모는 입고취소 불가', :'e' like '%PARTIALLY_SHIPPED%');

-- 자식도 다시 쪼갤 수 있다(대분할 → 소분할): 등심 40kg 자식 → 안심 38
create temp table res2 as
select public.split_inbound_scan(
    (select id from public.inbound_scans where parent_scan_id = 'e4e4e4e4-0000-0000-0000-0000000000c1' and weight = 40),
    '[{"product_id":"e4e4e4e4-0000-0000-0000-0000000000b3","weight":38}]'::jsonb) as r;
select pg_temp.expect('재쪼개기: 등심 20·안심 48',
    (select stock_quantity from public.products where id = 'e4e4e4e4-0000-0000-0000-0000000000b2') = 20
    and (select stock_quantity from public.products where id = 'e4e4e4e4-0000-0000-0000-0000000000b3') = 48);
