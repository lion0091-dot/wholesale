-- 주문 확정 재고 차감 — 091~094 회귀 복원 + 순차 초과 확정 차단 검증 (20260930000099)
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/db-test-order-stock-regression.sql
--
-- 동시 확정(두 세션 경쟁)은 psql 한 세션으로 재현이 안 되므로
-- scripts/db-test-order-stock-concurrency.sh 가 따로 맡는다.
\set ON_ERROR_STOP on
begin;

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
    execute p_sql;
    return 'ALLOWED';
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, what text, expected text, result text);
grant all on results to authenticated;

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;

-- ========== 시드 ==========
insert into auth.users (id,email) values
 ('98999999-0000-0000-0000-000000000001','owner@race.test'),
 ('98999999-0000-0000-0000-000000000003','retailer@race.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('98999999-0000-0000-0000-000000000001','wholesaler','A사장','010'),
 ('98999999-0000-0000-0000-000000000003','retailer','식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a8999999-0000-0000-0000-000000000001','98999999-0000-0000-0000-000000000001','A축산','9890000001','A','active');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('d8999999-0000-0000-0000-000000000001','98999999-0000-0000-0000-000000000003','식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status)
 values ('a8999999-0000-0000-0000-000000000001','d8999999-0000-0000-0000-000000000001','active');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('c8999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0),
 ('c8999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000001','한우 채끝','소','채끝','국내산','1+',52000,'kg',0),
 ('c8999999-0000-0000-0000-000000000003','a8999999-0000-0000-0000-000000000001','기초재고 상품','돼지','삼겹살','국내산',null,20000,'kg',3);

-- 주문들
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values
 ('e8999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001','d8999999-0000-0000-0000-000000000001','RACE-1',0,'awaiting_stock','서울'),
 ('e8999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000001','d8999999-0000-0000-0000-000000000001','RACE-2',0,'pending','서울'),
 ('e8999999-0000-0000-0000-000000000003','a8999999-0000-0000-0000-000000000001','d8999999-0000-0000-0000-000000000001','RACE-3',0,'pending','서울'),
 ('e8999999-0000-0000-0000-000000000004','a8999999-0000-0000-0000-000000000001','d8999999-0000-0000-0000-000000000001','RACE-4',0,'pending','서울'),
 ('e8999999-0000-0000-0000-000000000005','a8999999-0000-0000-0000-000000000001','d8999999-0000-0000-0000-000000000001','RACE-5',0,'awaiting_stock','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e8999999-0000-0000-0000-000000000001','c8999999-0000-0000-0000-000000000001','한우 등심',68000,5,340000),
 ('e8999999-0000-0000-0000-000000000002','c8999999-0000-0000-0000-000000000002','한우 채끝',52000,8.205,426660),
 ('e8999999-0000-0000-0000-000000000003','c8999999-0000-0000-0000-000000000003','기초재고 상품',20000,2,40000),
 ('e8999999-0000-0000-0000-000000000004','c8999999-0000-0000-0000-000000000003','기초재고 상품',20000,2,40000),
 ('e8999999-0000-0000-0000-000000000005','c8999999-0000-0000-0000-000000000001','한우 등심',68000,3,204000);

set role authenticated; set request.jwt.claim.sub = '98999999-0000-0000-0000-000000000001';
select public.upsert_master_livestock('008999999901','individual','mtrace_livestock','{}'::jsonb,'한우','소','채끝','1+',current_date-3,'○○도축장');

-- ========== T1. 확보 대기 주문 → 입고 즉시 배정 → 확정: 한 번만 빠져야 한다 (079 회귀) ==========
select public.record_inbound_scan('ZZ8999999901', 5.000, 'MANUAL') -> 'status' as t1_box_should_be_EXCEPTION;
select public.resolve_inbound_mapping_to_order(
    (select id from public.inbound_scans where trace_no='ZZ8999999901'),
    'c8999999-0000-0000-0000-000000000001',
    'e8999999-0000-0000-0000-000000000001', false) -> 'outbound' -> 'taken' as t1_assigned_should_be_5;
update public.orders set status='confirmed' where id='e8999999-0000-0000-0000-000000000001';

insert into results (what,expected,result) values
 ('T1 확정 후 등심 원장 합계(입고5 - 배정5 = 0, 이중 차감이면 -5)','0.000',
   (select coalesce(sum(qty_delta),0)::text from public.stock_ledger where product_id='c8999999-0000-0000-0000-000000000001')),
 ('T1 확정이 추가로 만든 ORDER_OUT 행 수','0',
   (select count(*)::text from public.stock_ledger where source_id='e8999999-0000-0000-0000-000000000001' and event_type='ORDER_OUT')),
 ('T1 표시 재고 = 원장 합계','0.000',
   (select stock_quantity::text from public.products where id='c8999999-0000-0000-0000-000000000001'));

-- ========== T2. 그램 단위 박스(8.205kg) 확정이 성공해야 한다 (068 회귀) ==========
select public.record_inbound_scan('008999999901', 8.205, 'BARCODE_SCAN', 'c8999999-0000-0000-0000-000000000002') -> 'status' as t2_box_should_be_NORMAL;
-- 주의: try()로 실행한 변경과 그 결과 확인은 문장을 나눈다 — 한 INSERT 안의 서브쿼리는
-- 그 문장 시작 시점 스냅샷을 써서 같은 문장 안 함수가 바꾼 값을 못 본다.
insert into results (what,expected,result) values
 ('T2 8.205kg 주문 확정','ALLOWED',
   pg_temp.try($q$update public.orders set status='confirmed' where id='e8999999-0000-0000-0000-000000000002'$q$));
insert into results (what,expected,result) values
 ('T2 박스 잔량 0.000 (반올림으로 8.21 빠지면 제약 위반)','0.000',
   (select remaining_weight::text from public.inbound_scans where trace_no='008999999901'));

-- ========== T3. 순차 초과 확정: 기초재고 3에 2+2 → 두 번째는 재고 부족 ==========
insert into results (what,expected,result) values
 ('T3 첫 확정(2/3)','ALLOWED',
   pg_temp.try($q$update public.orders set status='confirmed' where id='e8999999-0000-0000-0000-000000000003'$q$));
insert into results (what,expected,result) values
 ('T3 두 번째 확정(2, 남은 1)','DENIED: INSUFFICIENT_STOCK',
   pg_temp.try($q$update public.orders set status='confirmed' where id='e8999999-0000-0000-0000-000000000004'$q$));
insert into results (what,expected,result) values
 ('T3 표시 재고','1.000',
   (select stock_quantity::text from public.products where id='c8999999-0000-0000-0000-000000000003')),
 ('T3 원장 합계','1.000',
   (select coalesce(sum(qty_delta),0)::text from public.stock_ledger where product_id='c8999999-0000-0000-0000-000000000003'));

-- ========== T4. 배정만 된 확보 대기 주문 취소 → 재고 원복 (reverse 회귀) ==========
select public.record_inbound_scan('ZZ8999999902', 3.000, 'MANUAL') -> 'status' as t4_box_should_be_EXCEPTION;
select public.resolve_inbound_mapping_to_order(
    (select id from public.inbound_scans where trace_no='ZZ8999999902'),
    'c8999999-0000-0000-0000-000000000001',
    'e8999999-0000-0000-0000-000000000005', false) -> 'outbound' -> 'taken' as t4_assigned_should_be_3;
update public.orders set status='cancelled' where id='e8999999-0000-0000-0000-000000000005';
insert into results (what,expected,result) values
 ('T4 취소 후 박스 잔량 복원','3.000',
   (select remaining_weight::text from public.inbound_scans where trace_no='ZZ8999999902')),
 ('T4 취소 후 등심 표시 재고(T1 0 + 이 박스 3)','3.000',
   (select stock_quantity::text from public.products where id='c8999999-0000-0000-0000-000000000001'));

-- ========== 결과 ==========
reset role;
select no, what, expected, result, case when expected = result then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where expected = result) as pass,
       count(*) filter (where expected <> result) as fail
  from results;

rollback;
