-- 선입선출 자동배정 기한 제외 + 세트 유령 재고·보관 구성품 차단 검증 (20260930000100)
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/db-test-fifo-bundle-integrity.sql
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
 ('96999999-0000-0000-0000-000000000001','owner@fifo.test'),
 ('96999999-0000-0000-0000-000000000003','retailer@fifo.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('96999999-0000-0000-0000-000000000001','wholesaler','A사장','010'),
 ('96999999-0000-0000-0000-000000000003','retailer','식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a6999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000001','A축산','9690000001','A','active');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('d6999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000003','식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status)
 values ('a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','active');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('c6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','등심(기한혼합)','소','등심','국내산','1++',68000,'kg',0),
 ('c6999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000001','채끝(기한만료만)','소','채끝','국내산','1+',52000,'kg',0),
 ('c6999999-0000-0000-0000-000000000003','a6999999-0000-0000-0000-000000000001','안심(기초재고+만료박스)','소','안심','국내산','1+',90000,'kg',5),
 ('c6999999-0000-0000-0000-000000000004','a6999999-0000-0000-0000-000000000001','재고10 상품(세트 지정 시도)','돼지','삼겹살','국내산',null,20000,'kg',10),
 ('c6999999-0000-0000-0000-000000000005','a6999999-0000-0000-0000-000000000001','재고0 상품(세트 지정)','돼지','목살','국내산',null,20000,'kg',0),
 ('c6999999-0000-0000-0000-000000000006','a6999999-0000-0000-0000-000000000001','삼겹살 구성품','돼지','삼겹살','국내산',null,20000,'kg',0),
 ('c6999999-0000-0000-0000-000000000007','a6999999-0000-0000-0000-000000000001','목살 구성품(보관될 것)','돼지','목살','국내산',null,18000,'kg',0);
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values
 ('e6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','FIFO-1',0,'pending','서울'),
 ('e6999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','FIFO-2',0,'pending','서울'),
 ('e6999999-0000-0000-0000-000000000003','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','FIFO-3',0,'pending','서울'),
 ('e6999999-0000-0000-0000-000000000004','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','FIFO-4',0,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e6999999-0000-0000-0000-000000000001','c6999999-0000-0000-0000-000000000001','등심',68000,4,272000),
 ('e6999999-0000-0000-0000-000000000002','c6999999-0000-0000-0000-000000000002','채끝',52000,2,104000),
 ('e6999999-0000-0000-0000-000000000003','c6999999-0000-0000-0000-000000000003','안심',90000,4,360000);

set role authenticated; set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000001';

-- 박스: 등심 — 기한 지난 3kg(먼저 입고) + 정상 5kg / 채끝 — 기한 지난 3kg만 / 안심 — 기한 지난 3kg
select public.record_inbound_scan('ZZ6999999901', 3.000, 'MANUAL', 'c6999999-0000-0000-0000-000000000001', p_best_before => current_date - 1) -> 'status' as seed1;
select public.record_inbound_scan('ZZ6999999902', 5.000, 'MANUAL', 'c6999999-0000-0000-0000-000000000001', p_best_before => current_date + 10) -> 'status' as seed2;
select public.record_inbound_scan('ZZ6999999903', 3.000, 'MANUAL', 'c6999999-0000-0000-0000-000000000002', p_best_before => current_date - 1) -> 'status' as seed3;
select public.record_inbound_scan('ZZ6999999904', 3.000, 'MANUAL', 'c6999999-0000-0000-0000-000000000003', p_best_before => current_date - 1) -> 'status' as seed4;
-- 상품 확정을 위해 EXCEPTION 박스들을 상품에 매핑(이력 미등록이라 EXCEPTION으로 들어감)
select public.resolve_inbound_mapping(id, product_id, false) -> 'status' as resolved
  from public.inbound_scans where trace_no like 'ZZ69999999%' and status = 'EXCEPTION';

-- ========== E1. 기한 지난 박스는 자동배정에서 빠진다 ==========
insert into results (what,expected,result) values
 ('E1 등심 4kg 확정(정상 박스 5kg에서)','ALLOWED',
   pg_temp.try($q$update public.orders set status='confirmed' where id='e6999999-0000-0000-0000-000000000001'$q$));
insert into results (what,expected,result) values
 ('E1 기한 지난 박스는 그대로(3.000)','3.000',
   (select remaining_weight::text from public.inbound_scans where trace_no='ZZ6999999901')),
 ('E1 정상 박스에서 4 빠짐(1.000)','1.000',
   (select remaining_weight::text from public.inbound_scans where trace_no='ZZ6999999902'));

-- ========== E2. 기한 지난 박스밖에 없으면 재고 부족 (박스 없는 분량으로 몰래 안 빠짐) ==========
insert into results (what,expected,result) values
 ('E2 채끝 2kg 확정','DENIED: INSUFFICIENT_STOCK',
   pg_temp.try($q$update public.orders set status='confirmed' where id='e6999999-0000-0000-0000-000000000002'$q$));
insert into results (what,expected,result) values
 ('E2 채끝 원장 합계 그대로(3.000)','3.000',
   (select coalesce(sum(qty_delta),0)::text from public.stock_ledger where product_id='c6999999-0000-0000-0000-000000000002'));

-- ========== E3. 기초재고 5 + 기한 지난 박스 3: 4kg 주문은 기초재고에서만 ==========
insert into results (what,expected,result) values
 ('E3 안심 4kg 확정(기초재고 5에서)','ALLOWED',
   pg_temp.try($q$update public.orders set status='confirmed' where id='e6999999-0000-0000-0000-000000000003'$q$));
insert into results (what,expected,result) values
 ('E3 기한 지난 박스 그대로(3.000)','3.000',
   (select remaining_weight::text from public.inbound_scans where trace_no='ZZ6999999904')),
 ('E3 박스 없는 차감 4','4.000',
   (select coalesce(-sum(qty_delta),0)::text from public.stock_ledger where source_id='e6999999-0000-0000-0000-000000000003' and inbound_scan_id is null)),
 ('E3 표시 재고 = 5 + 3 - 4','4.000',
   (select stock_quantity::text from public.products where id='c6999999-0000-0000-0000-000000000003'));

-- ========== E4. 수동 재고가 남은 상품은 세트로 지정 못 한다 ==========
insert into results (what,expected,result) values
 ('E4 재고 10 상품 세트 지정','DENIED: PRODUCT_HAS_MANUAL_STOCK',
   pg_temp.try($q$select public.save_product_bundle('[{"product_id":"c6999999-0000-0000-0000-000000000006","quantity":2}]'::jsonb, p_product_id => 'c6999999-0000-0000-0000-000000000004')$q$)),
 ('E4 재고 0 상품 세트 지정','ALLOWED',
   pg_temp.try($q$select public.save_product_bundle('[{"product_id":"c6999999-0000-0000-0000-000000000006","quantity":2},{"product_id":"c6999999-0000-0000-0000-000000000007","quantity":1}]'::jsonb, p_product_id => 'c6999999-0000-0000-0000-000000000005')$q$));

-- ========== E5. 보관된 구성품이 있으면 세트를 못 만든다 ==========
select public.record_inbound_scan('ZZ6999999905', 10.000, 'MANUAL', 'c6999999-0000-0000-0000-000000000006') -> 'status' as seed5;
select public.record_inbound_scan('ZZ6999999906', 10.000, 'MANUAL', 'c6999999-0000-0000-0000-000000000007') -> 'status' as seed6;
select public.resolve_inbound_mapping(id, product_id, false) -> 'status' as resolved
  from public.inbound_scans where trace_no in ('ZZ6999999905','ZZ6999999906') and status = 'EXCEPTION';
select public.set_product_archived('c6999999-0000-0000-0000-000000000007', true) -> 'archived' as archived_component;
insert into results (what,expected,result) values
 ('E5 보관 구성품 포함 세트 제작','DENIED: COMPONENT_ARCHIVED',
   pg_temp.try($q$select public.assemble_product_bundle((select id from public.product_bundles where product_id='c6999999-0000-0000-0000-000000000005'), 1)$q$));
select public.set_product_archived('c6999999-0000-0000-0000-000000000007', false) -> 'archived' as unarchived;

-- ========== E6. 같은 트랜잭션에서 만든 세트 2개 → 주문 1세트 확정은 001번부터 ==========
select public.assemble_product_bundle((select id from public.product_bundles where product_id='c6999999-0000-0000-0000-000000000005'), 2) -> 'assembled' as made_2_sets;
-- 주문 품목 시드는 RLS 밖(postgres)에서 넣는다
reset role;
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e6999999-0000-0000-0000-000000000004','c6999999-0000-0000-0000-000000000005','세트',45000,1,45000);
set role authenticated; set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000001';
insert into results (what,expected,result) values
 ('E6 세트 1개 주문 확정','ALLOWED',
   pg_temp.try($q$update public.orders set status='confirmed' where id='e6999999-0000-0000-0000-000000000004'$q$));
insert into results (what,expected,result) values
 ('E6 001번 세트가 나감(잔량 0)','0.000',
   (select remaining_weight::text from public.inbound_scans where trace_no = (select min(set_no) from public.bundle_assemblies where wholesaler_id='a6999999-0000-0000-0000-000000000001'))),
 ('E6 002번 세트는 남음(잔량 1)','1.000',
   (select remaining_weight::text from public.inbound_scans where trace_no = (select max(set_no) from public.bundle_assemblies where wholesaler_id='a6999999-0000-0000-0000-000000000001')));

-- ========== 결과 ==========
reset role;
select no, what, expected, result, case when expected = result then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where expected = result) as pass,
       count(*) filter (where expected <> result) as fail
  from results;

rollback;
