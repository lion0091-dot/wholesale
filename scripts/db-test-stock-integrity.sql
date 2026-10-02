-- 재고·박스·원장 일치 점검(213) — 정상이면 0, 일부러 틀어뜨리면 해당 점검만 정확히 잡고, "정상으로 보는 것"은 안 센다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-stock-integrity.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- 한 업체만 보고, 점검별 (건수) 를 "키=건수" 문자열로 돌려준다 — 다른 데이터가 섞이지 않게 항상 이 업체로 좁힌다.
create function pg_temp.check_counts() returns text language sql as $$
    select string_agg(check_key || '=' || violations, ',' order by check_key)
    from public.stock_integrity_violations('a9999999-0000-0000-0000-000000000001');
$$;

-- 시드
insert into auth.users (id,email) values ('99999999-9999-0000-0000-000000000001','owner@integ.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('99999999-9999-0000-0000-000000000001','wholesaler','대표','010',true,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a9999999-0000-0000-0000-000000000001','99999999-9999-0000-0000-000000000001','점검축산','9990000001','대표','active');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('c9999999-0000-0000-0000-000000000001','a9999999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',10,true),
 -- 원장 도입 전 수동 재고: 원장 행이 없으니 stock_quantity와 달라도 정상
 ('c9999999-0000-0000-0000-000000000002','a9999999-0000-0000-0000-000000000001','수동 재고 상품','돼지','삼겹살','국내산',null,20000,'kg',5,true);
-- 정상 박스 하나: 입고 10kg(원장 +10), 잔량 10
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight) values
 ('b9999999-0000-0000-0000-000000000001','a9999999-0000-0000-0000-000000000001','099900000001',10,'kg','MANUAL','NORMAL','c9999999-0000-0000-0000-000000000001',10);
insert into public.stock_ledger (wholesaler_id,product_id,inbound_scan_id,qty_delta,event_type,source_type,source_id) values
 ('a9999999-0000-0000-0000-000000000001','c9999999-0000-0000-0000-000000000001','b9999999-0000-0000-0000-000000000001',10,'INBOUND','inbound_scan','b9999999-0000-0000-0000-000000000001');
-- 확인 필요 박스: 상품이 정해지기 전이라 원장에 없는 게 정상
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,remaining_weight) values
 ('b9999999-0000-0000-0000-000000000002','a9999999-0000-0000-0000-000000000001','099900000002',7,'kg','MANUAL','PENDING_MAPPING',7),
 ('b9999999-0000-0000-0000-000000000003','a9999999-0000-0000-0000-000000000001','099900000003',4,'kg','MANUAL','EXCEPTION',4);

-- ========== 정상 상태 ==========
insert into results (who,what,expected,result) values
 ('시스템','정상 상태(원장 도입 전 수동 재고·확인 필요 박스 포함)에서는 전부 0','box_over_weight=0,box_remaining_vs_ledger=0,boxes_exceed_stock=0,normal_box_without_ledger=0,product_stock_vs_ledger=0,voided_box_with_remaining=0', pg_temp.check_counts());

-- ========== 일부러 틀어뜨리기: 하나씩 하고 되돌린다 ==========
update public.products set stock_quantity = 11 where id = 'c9999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('시스템','상품 재고를 원장과 다르게(11 ≠ 10) → 상품-원장 불일치 1건','1', (select violations::text from public.stock_integrity_violations('a9999999-0000-0000-0000-000000000001') where check_key='product_stock_vs_ledger')),
 ('시스템','  └ 어느 상품인지 표본에 나온다','c9999999-0000-0000-0000-000000000001', (select sample_ids[1] from public.stock_integrity_violations('a9999999-0000-0000-0000-000000000001') where check_key='product_stock_vs_ledger'));
update public.products set stock_quantity = 10 where id = 'c9999999-0000-0000-0000-000000000001';

update public.inbound_scans set remaining_weight = 9 where id = 'b9999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('시스템','박스 잔량을 원장과 다르게(9 ≠ 10) → 박스-원장 불일치 1건','1', (select violations::text from public.stock_integrity_violations('a9999999-0000-0000-0000-000000000001') where check_key='box_remaining_vs_ledger'));
update public.inbound_scans set remaining_weight = 10 where id = 'b9999999-0000-0000-0000-000000000001';

insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight) values
 ('b9999999-0000-0000-0000-000000000004','a9999999-0000-0000-0000-000000000001','099900000004',3,'kg','MANUAL','NORMAL','c9999999-0000-0000-0000-000000000001',0);
insert into results (who,what,expected,result) values
 ('시스템','입고 확정(NORMAL)인데 원장이 없는 박스 → 1건','1', (select violations::text from public.stock_integrity_violations('a9999999-0000-0000-0000-000000000001') where check_key='normal_box_without_ledger'));
delete from public.inbound_scans where id = 'b9999999-0000-0000-0000-000000000004';

update public.inbound_scans set remaining_weight = 12 where id = 'b9999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('시스템','박스 잔량이 입고 중량보다 큼(12 > 10) → 1건','1', (select violations::text from public.stock_integrity_violations('a9999999-0000-0000-0000-000000000001') where check_key='box_over_weight'));
update public.inbound_scans set remaining_weight = 10 where id = 'b9999999-0000-0000-0000-000000000001';

insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight) values
 ('b9999999-0000-0000-0000-000000000005','a9999999-0000-0000-0000-000000000001','099900000005',3,'kg','MANUAL','VOIDED','c9999999-0000-0000-0000-000000000001',3);
insert into results (who,what,expected,result) values
 ('시스템','취소된 박스에 잔량이 남음 → 1건','1', (select violations::text from public.stock_integrity_violations('a9999999-0000-0000-0000-000000000001') where check_key='voided_box_with_remaining'));
delete from public.inbound_scans where id = 'b9999999-0000-0000-0000-000000000005';

update public.products set stock_quantity = 5 where id = 'c9999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('시스템','남은 박스 합계(10)가 상품 재고(5)보다 큼 → 1건','1', (select violations::text from public.stock_integrity_violations('a9999999-0000-0000-0000-000000000001') where check_key='boxes_exceed_stock'));
update public.products set stock_quantity = 10 where id = 'c9999999-0000-0000-0000-000000000001';

insert into results (who,what,expected,result) values
 ('시스템','되돌린 뒤 다시 전부 0','box_over_weight=0,box_remaining_vs_ledger=0,boxes_exceed_stock=0,normal_box_without_ledger=0,product_stock_vs_ledger=0,voided_box_with_remaining=0', pg_temp.check_counts());

-- ========== 권한: 서버(크론)·운영자 전용 ==========
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ALLOWED'; exception when others then return 'DENIED'; end $$;
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '99999999-9999-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('업체 대표','일반 사용자가 점검 함수 호출 → 거부','DENIED', pg_temp.try($q$select * from public.stock_integrity_violations()$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','익명이 점검 함수 호출 → 거부','DENIED', pg_temp.try($q$select * from public.stock_integrity_violations()$q$));
reset role;

select '--- 결과 ---' as t;
select no, who, what, expected, result, case when result = expected then 'PASS' else 'FAIL' end as verdict from results order by no;
select count(*) filter (where result = expected) as pass, count(*) filter (where result <> expected) as fail from results;
