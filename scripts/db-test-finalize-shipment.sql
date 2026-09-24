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
 ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0);

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select '--- F1: g 단위 중량이 반올림 없이 그대로 저장된다 (8.204kg) ---' as t;
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-5,'○○도축장');
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.record_inbound_scan('002111111111', 8.204,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.record_inbound_scan('002222222222', 1.496,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select trace_no, weight as should_keep_grams from public.inbound_scans order by created_at;
select stock_quantity as should_be_9_700 from public.products where id='cccccccc-0000-0000-0000-000000000002';

reset role;
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-001',612000,'pending','서울');
-- 9kg 주문 (재고 9.7kg 이라 확정 가능)
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002','한우 등심',68000,9,612000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';

select '--- F2: 스캔 전 미리보기는 차이 0 (자동 배정이 주문량과 같다) ---' as t;
select product_name, ordered_qty, shipped_qty, diff_qty, ordered_amount, shipped_amount
  from public.preview_order_shipment('eeeeeeee-0000-0000-0000-000000000001');

select '--- F3: 작업자가 8.204 박스 하나만 찍고 끝냄 (0.796kg 부족) ---' as t;
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002111111111') -> 'taken';
select product_name, ordered_qty, shipped_qty, diff_qty, ordered_amount, shipped_amount
  from public.preview_order_shipment('eeeeeeee-0000-0000-0000-000000000001');

select '--- F4: 확인 없이 마감하면 막힌다 ---' as t;
do $$ begin
  perform public.finalize_order_shipment('eeeeeeee-0000-0000-0000-000000000001');
  raise exception 'FAIL: 부족한데 그냥 마감됨';
exception when others then
  if sqlerrm = 'SHIPMENT_SHORT' then raise notice 'PASS: 확인 없이는 마감 차단';
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- F5: 확인하면 실제 중량으로 금액 확정 (8.204 × 68000 = 557,872) ---' as t;
select public.finalize_order_shipment('eeeeeeee-0000-0000-0000-000000000001', true);
select quantity as ordered_stays_9, shipped_quantity as should_be_8_204, subtotal_amount as should_be_557872
  from public.order_items where order_id='eeeeeeee-0000-0000-0000-000000000001';
select total_amount as should_be_557872, status as should_be_shipping
  from public.orders where id='eeeeeeee-0000-0000-0000-000000000001';

select '--- F6: 재고는 건드리지 않는다 (9.700 - 8.204 = 1.496) ---' as t;
select stock_quantity as should_be_1_496 from public.products where id='cccccccc-0000-0000-0000-000000000002';

select '--- F7: 두 번 마감은 거부 ---' as t;
do $$ begin
  perform public.finalize_order_shipment('eeeeeeee-0000-0000-0000-000000000001', true);
  raise exception 'FAIL: 중복 마감됨';
exception when others then
  if sqlerrm = 'ALREADY_FINALIZED' then raise notice 'PASS: 중복 마감 차단';
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- F8: 남의 주문 미리보기는 0행 ---' as t;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as should_be_0 from public.preview_order_shipment('eeeeeeee-0000-0000-0000-000000000001');
