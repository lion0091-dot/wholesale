\set ON_ERROR_STOP on
-- ===== 시드 =====
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@t.com'),
  ('33333333-3333-3333-3333-333333333333','r@t.com');
-- handle_new_user 트리거가 profiles를 미리 만들 수 있고, role은 불변 트리거가 막는다.
-- 테스트 시드에서만 잠시 내려둔다.
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values
  ('11111111-1111-1111-1111-111111111111','wholesaler','A사장','01011111111'),
  ('33333333-3333-3333-3333-333333333333','retailer','식당','01033333333')
on conflict (id) do update set role=excluded.role, name=excluded.name, phone=excluded.phone;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name)
  values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A사장');
insert into public.retailers (id, profile_id, restaurant_name, representative_name, delivery_address)
  values ('dddddddd-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','○○식당','사장','서울시');
insert into public.wholesaler_retailers (wholesaler_id, retailer_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001');

-- P1: 기존 상품(수동 재고 20kg, 박스 없음) / P2: 이력 관리 상품
insert into public.products (id, wholesaler_id, name, category, subcategory, origin, base_price, unit, stock_quantity) values
 ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','수입 삼겹살','돼지','삼겹살','수입산',18000,'kg',20),
 ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 등심 1++','소','등심','국내산',68000,'kg',0);

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 박스 2개 입고 (8.20 + 7.50)
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++','2026-09-18'::date,'○○도축장');
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++','2026-09-19'::date,'○○도축장');
select public.record_inbound_scan('002111111111', 8.20, 'BARCODE_SCAN', 'cccccccc-0000-0000-0000-000000000002') -> 'status';
select public.record_inbound_scan('002222222222', 7.50, 'BARCODE_SCAN', 'cccccccc-0000-0000-0000-000000000002') -> 'status';

-- ===== T1: 기존 수동 재고 상품 — 기초재고 이관 확인 =====
select '--- T1: 수동재고 20kg 상품에 5kg 주문 확정 ---' as t;
reset role;
insert into public.orders (id, wholesaler_id, retailer_id, order_number, total_amount, status, delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-001',90000,'pending','서울시');
insert into public.order_items (order_id, product_id, product_name, unit_price, quantity, subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','수입 삼겹살',18000,5,90000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';
select name, stock_quantity as should_be_15 from public.products where id='cccccccc-0000-0000-0000-000000000001';
select event_type, qty_delta, reason from public.stock_ledger where product_id='cccccccc-0000-0000-0000-000000000001' order by created_at;

-- ===== T2: 박스 상품 — 선입선출 차감 =====
select '--- T2: 박스 상품(15.70kg)에 10kg 주문 확정 ---' as t;
reset role;
insert into public.orders (id, wholesaler_id, retailer_id, order_number, total_amount, status, delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-002',680000,'pending','서울시');
insert into public.order_items (order_id, product_id, product_name, unit_price, quantity, subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000002','한우 등심 1++',68000,10,680000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000002';
select name, stock_quantity as should_be_5_70 from public.products where id='cccccccc-0000-0000-0000-000000000002';
select trace_no, weight, remaining_weight from public.inbound_scans order by created_at;

-- ===== T3: 거래명세서용 이력번호 조회 =====
select '--- T3: 이 주문에 나간 이력번호 ---' as t;
select trace_no, quantity, grade, slaughter_date from public.get_order_trace_numbers('eeeeeeee-0000-0000-0000-000000000002');

-- ===== T4: 취소 → 원복 =====
select '--- T4: 주문 취소 원복 ---' as t;
update public.orders set status='cancelled' where id='eeeeeeee-0000-0000-0000-000000000002';
select name, stock_quantity as should_be_15_70 from public.products where id='cccccccc-0000-0000-0000-000000000002';
select trace_no, remaining_weight as should_be_8_20_and_7_50 from public.inbound_scans order by created_at;

-- ===== T5: 이중 차감 방지 =====
select '--- T5: 같은 주문 재차감 시도 ---' as t;
reset role;
select public.apply_order_shipment('eeeeeeee-0000-0000-0000-000000000001');
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select stock_quantity as should_still_be_15 from public.products where id='cccccccc-0000-0000-0000-000000000001';

-- ===== T6: 재고 부족 → 확정 차단 =====
select '--- T6: 재고 부족 주문 확정 ---' as t;
reset role;
insert into public.orders (id, wholesaler_id, retailer_id, order_number, total_amount, status, delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-003',1800000,'pending','서울시');
insert into public.order_items (order_id, product_id, product_name, unit_price, quantity, subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000003','cccccccc-0000-0000-0000-000000000001','수입 삼겹살',18000,100,1800000);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin
  update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000003';
  raise exception 'FAIL: 재고 부족인데 확정됨';
exception when others then
  if sqlerrm like 'INSUFFICIENT_STOCK:%' then raise notice 'PASS: %', sqlerrm;
  else raise exception 'FAIL: 예상과 다른 오류 %', sqlerrm; end if;
end $$;
select status as should_still_be_pending from public.orders where id='eeeeeeee-0000-0000-0000-000000000003';
