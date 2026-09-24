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
-- 박스 3개: A(오래됨) 8.2 / B 7.5 / C 6.0
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-5,'○○도축장');
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('002333333333','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-1,'○○도축장');
select public.record_inbound_scan('002111111111', 8.20,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.record_inbound_scan('002222222222', 7.50,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.record_inbound_scan('002333333333', 6.00,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';

reset role;
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-001',680000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002','한우 등심',68000,10,680000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';

select '--- O1: 확정 시 자동 배정은 선입선출(A 8.2 + B 1.8) ---' as t;
select trace_no, weight, remaining_weight from public.inbound_scans order by created_at;

select '--- O2: 작업자가 실제로는 C 박스를 집어 스캔 ---' as t;
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002333333333');
select trace_no, remaining_weight from public.inbound_scans order by created_at;

select '--- O3: 남은 4kg을 B 박스에서 채움 ---' as t;
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002222222222');
select * from public.get_outbound_progress('eeeeeeee-0000-0000-0000-000000000001');

select '--- O4: 재고 총량은 그대로 (21.7 - 10 = 11.7) ---' as t;
select stock_quantity as should_be_11_70 from public.products where id='cccccccc-0000-0000-0000-000000000002';

select '--- O5: 거래명세서 이력번호는 실제 스캔분만 ---' as t;
select trace_no, quantity from public.get_order_trace_numbers('eeeeeeee-0000-0000-0000-000000000001');

select '--- O6: 다 채운 뒤 또 찍으면 거부 ---' as t;
do $$ begin
  perform public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002111111111');
  raise exception 'FAIL: 초과 배정됨';
exception when others then
  if sqlerrm = 'PRODUCT_ALREADY_FULFILLED' then raise notice 'PASS: 초과 배정 차단';
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- O7: 주문에 없는 상품 박스는 거부 ---' as t;
select public.upsert_master_livestock('002444444444','individual','mtrace_livestock','{}'::jsonb,'한우','소','채끝','1+',current_date-1,'○○도축장');
select public.record_inbound_scan('002444444444', 5.00,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000003') -> 'status';
do $$ begin
  perform public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002444444444');
  raise exception 'FAIL: 엉뚱한 박스가 배정됨';
exception when others then
  if sqlerrm = 'PRODUCT_NOT_IN_ORDER' then raise notice 'PASS: 주문에 없는 상품 차단';
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- O8: 기간 요약의 출고 합계가 맞는다 (-10) ---' as t;
-- 입고 26.70 = 등심 3박스(21.70) + O7에서 넣은 채끝 1박스(5.00)
select inbound_qty as should_be_26_70, outbound_qty as should_be_minus_10
  from public.summarize_stock_ledger('aaaaaaaa-0000-0000-0000-000000000001');

select '--- O9: 소분 라벨 정보 (실제 스캔분 기준) ---' as t;
select product_name, trace_no, quantity, unit, grade, origin, supplier_name, retailer_name, order_number
  from public.get_order_labels('eeeeeeee-0000-0000-0000-000000000001');
