\set ON_ERROR_STOP on
insert into auth.users (id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('33333333-3333-3333-3333-333333333333','r@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('11111111-1111-1111-1111-111111111111','wholesaler','A','010'),
 ('33333333-3333-3333-3333-333333333333','retailer','식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('dddddddd-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','식당','사장','서울');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity)
 values ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산',68000,'kg',0);
insert into public.market_price_snapshots (species, grade, price_per_kg, snapshot_date, source)
 values ('cattle', '1++', 25000, current_date, 'cattle');

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 도축일이 다른 박스 2개 (오래된 것 40일 전, 최근 것 3일 전)
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,
  '한우','소','등심','1+', (current_date - 40), '○○도축장', null, null, null, (current_date - 38));
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,
  '한우','소','등심','1++',(current_date - 3), '○○도축장', null, null, null, (current_date - 2));
select public.record_inbound_scan('002111111111', 8.20,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.record_inbound_scan('002222222222', 7.50,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';

select '--- F1: 상품별 신선도 요약 ---' as t;
select box_count, oldest_slaughter_date, latest_slaughter_date, oldest_packing_date, grades
  from public.get_product_stock_summary('aaaaaaaa-0000-0000-0000-000000000001');

select '--- F2: 공급사는 경락가 조회 가능 ---' as t;
select count(*) as supplier_sees_should_be_1 from public.market_price_snapshots;

select '--- F3: 고객(식당)은 경락가 안 보임 ---' as t;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as retailer_sees_should_be_0 from public.market_price_snapshots;
