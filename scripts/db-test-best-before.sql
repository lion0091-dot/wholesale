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
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-20,'○○도축장');
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('002333333333','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-1,'○○도축장');

select '--- B1: 기한 지난 박스도 입고는 받는다 (반품·폐기 기록용) ---' as t;
select (public.record_inbound_scan('002111111111', 5.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002',
        null,null,null,false, current_date-1)) -> 'expired' as should_be_true;

select '--- B2: 임박(D+2) / 여유(D+30) 박스 ---' as t;
select (public.record_inbound_scan('002222222222', 6.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002',
        null,null,null,false, current_date+2)) -> 'days_left' as should_be_2;
select (public.record_inbound_scan('002333333333', 7.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002',
        null,null,null,false, current_date+30)) -> 'days_left' as should_be_30;

select '--- B3: 임박 재고 조회 (기본 3일) — 지난 것 + D+2 만 ---' as t;
select trace_no, remaining_weight, days_left, expired from public.get_expiring_boxes();

select '--- B4: 유통기한 없는 박스는 대상 아님 ---' as t;
select public.upsert_master_livestock('002444444444','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-2,'○○도축장');
select public.record_inbound_scan('002444444444', 4.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002') -> 'status';
select count(*) as still_2 from public.get_expiring_boxes();

reset role;
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-001',340000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002','한우 등심',68000,5,340000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';

select '--- B5: 기한 지난 박스는 출고 차단 (확인 버튼 없음) ---' as t;
do $$ begin
  perform public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002111111111');
  raise exception 'FAIL: 기한 지난 박스가 출고됨';
exception when others then
  if sqlerrm like 'BOX_EXPIRED:%' then raise notice 'PASS: 기한 경과 출고 차단 (%)', sqlerrm;
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- B6: 임박 박스는 출고되되 남은 일수를 알려준다 ---' as t;
select (public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','002222222222')) -> 'days_left' as should_be_2;

select '--- B7: 피킹 목록에 유통기한이 함께 나온다 ---' as t;
select trace_no, suggested_qty, best_before, days_left, already_picked
  from public.get_picking_list('eeeeeeee-0000-0000-0000-000000000001');
