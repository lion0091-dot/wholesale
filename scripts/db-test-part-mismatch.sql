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
insert into public.wholesaler_retailers (wholesaler_id,retailer_id)
 values ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0),
 ('cccccccc-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','한우 채끝등심','소','채끝등심','국내산','1++',60000,'kg',0);

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select '--- M1: 이력은 채끝인데 등심 상품으로 지정 → 경고 ---' as t;
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','채끝','1++',current_date-3,'○○도축장');
select public.record_inbound_scan('002111111111', 8.20, 'BARCODE_SCAN') -> 'status' as pending;
select public.resolve_inbound_mapping(
  (select id from public.inbound_scans where trace_no='002111111111'),
  'cccccccc-0000-0000-0000-000000000002', false) as should_warn;

select '--- M2: 표기만 다른 경우("채끝" vs "채끝등심") → 경고 없음 ---' as t;
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소','채끝','1++',current_date-2,'○○도축장');
select public.record_inbound_scan('002222222222', 7.50, 'BARCODE_SCAN') -> 'status';
select public.resolve_inbound_mapping(
  (select id from public.inbound_scans where trace_no='002222222222'),
  'cccccccc-0000-0000-0000-000000000004', false) as should_not_warn;

select '--- M3: 출고에서도 같은 경고가 나온다 ---' as t;
reset role;
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-001',340000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002','한우 등심',68000,5,340000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002111111111', 5.0) as should_warn;
