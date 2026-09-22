\set ON_ERROR_STOP on
insert into auth.users (id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('33333333-3333-3333-3333-333333333333','r@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('11111111-1111-1111-1111-111111111111','wholesaler','A사장','010'),
 ('33333333-3333-3333-3333-333333333333','retailer','식당','010')
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('dddddddd-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','○○식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id)
 values ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity)
 values ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.record_inbound_scan('002111111111', 8.20,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-2,'○○도축장');
select public.record_inbound_scan('002222222222', 7.50,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.adjust_product_stock('cccccccc-0000-0000-0000-000000000002', 15.40, 'DISPOSAL', '일부 폐기');

reset role;
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-001',340000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002','한우 등심',68000,5,340000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';

select '--- L1: 원장 전체 (오래된 순 + 시점 재고) ---' as t;
select event_type, qty_delta, balance_after, product_name, trace_no, order_number, reason, actor_name
  from public.list_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001');

select '--- L2: 기간 요약 ---' as t;
select * from public.summarize_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001');

select '--- L3: 유형 필터(출고만) — 시점 재고는 전체 기준이어야 함 ---' as t;
select event_type, qty_delta, balance_after as should_be_10_40, order_number
  from public.list_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001', null, null, null, array['ORDER_OUT']);

select '--- L5: 최종 재고와 마지막 시점 재고가 같아야 함 ---' as t;
select (select stock_quantity from public.products where id='cccccccc-0000-0000-0000-000000000002') as product_stock,
       (select balance_after from public.list_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001')
          order by created_at desc limit 1) as last_balance;

select '--- L6: 이력번호로 입고+출고 함께 추적 ---' as t;
select event_type, qty_delta, balance_after, trace_no, order_number
  from public.list_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001', null, null, null, null, '002111111111');

select '--- L7: 번호 일부만 입력해도 찾음 ---' as t;
select count(*) as should_be_2
  from public.list_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001', null, null, null, null, '0021111');

select '--- L8: 다른 번호는 입고 1건만 ---' as t;
select event_type, qty_delta, trace_no
  from public.list_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001', null, null, null, null, '002222222222');

select '--- L4: 남의 업체 조회 차단 ---' as t;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as retailer_sees_should_be_0
  from public.list_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001');
