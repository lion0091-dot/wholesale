\set ON_ERROR_STOP on
insert into auth.users (id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('33333333-3333-3333-3333-333333333333','r@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('11111111-1111-1111-1111-111111111111','wholesaler','A사장','010'),
 ('33333333-3333-3333-3333-333333333333','retailer','식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('dddddddd-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','○○식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id)
 values ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0),
 ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','한우 채끝','소','채끝','국내산','1+',52000,'kg',0);

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
-- 등심 박스 3개: A(오래됨) 8.2 / B 7.5 / C 6.0, 채끝 1개 5.0
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-5,'○○도축장');
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('002333333333','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-1,'○○도축장');
select public.upsert_master_livestock('002444444444','individual','mtrace_livestock','{}'::jsonb,'한우','소','채끝','1+',current_date-2,'○○도축장');
select public.record_inbound_scan('002111111111', 8.20,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.record_inbound_scan('002222222222', 7.50,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.record_inbound_scan('002333333333', 6.00,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.record_inbound_scan('002444444444', 5.00,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000003') -> 'status';

reset role;
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-001',836000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002','한우 등심',68000,10,680000),
 ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000003','한우 채끝',52000,3,156000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';

select '--- P1: 스캔 전 — 확정 때 잡은 선입선출 배정이 그대로 추천 (A 8.2 + B 1.8 + 채끝 3) ---' as t;
select product_name, trace_no, suggested_qty, box_weight, grade, slaughter_date, already_picked
  from public.get_picking_list('eeeeeeee-0000-0000-0000-000000000001');

select '--- P2: 작업자가 추천을 무시하고 C 박스(최신)를 6.0 찍음 ---' as t;
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002333333333');

select '--- P3: 스캔 후 — 찍은 C는 already_picked, 남은 4kg은 A(8.2)에서 선입선출 ---' as t;
select product_name, trace_no, suggested_qty, already_picked
  from public.get_picking_list('eeeeeeee-0000-0000-0000-000000000001');

select '--- P4: 채끝 3kg을 찍으면 그 상품은 추천에서 빠진다 ---' as t;
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002444444444', 3.00);
select product_name, trace_no, suggested_qty, already_picked
  from public.get_picking_list('eeeeeeee-0000-0000-0000-000000000001');

select '--- P5: 등심 남은 4kg을 A에서 찍으면 추천은 비고 찍은 것만 남는다 ---' as t;
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002111111111', 4.00);
select product_name, trace_no, suggested_qty, already_picked
  from public.get_picking_list('eeeeeeee-0000-0000-0000-000000000001');

select '--- P6: 남의 주문은 못 본다 ---' as t;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as should_be_0 from public.get_picking_list('eeeeeeee-0000-0000-0000-000000000001');
