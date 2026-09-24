-- 권한 게이트 NULL 비교 버그 수정(20260930000097) 검증
--
-- 실행(로컬 Docker DB, 전부 롤백되므로 데이터가 남지 않는다):
--   docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/db-test-tenant-gate-null.sql
--
-- 기대: 아래 출력의 expected 칸과 result 칸이 전부 일치하고, 마지막 요약이 "FAIL 0".
\set ON_ERROR_STOP on
begin;

-- 예외를 삼켜 "ALLOWED / DENIED: 사유"로 돌려주는 도우미 (서브트랜잭션이라 트랜잭션이 안 깨진다)
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
    execute p_sql;
    return 'ALLOWED';
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
-- 아래에서 set role authenticated로 바꿔 넣으므로 그 롤에 쓰기 권한을 준다
grant all on results to authenticated;

-- ========== 시드 (이 스크립트 전용 ID — 다른 테스트와 충돌 방지) ==========
insert into auth.users (id,email) values
 ('99999999-0000-0000-0000-000000000001','owner-a@gate.test'),
 ('99999999-0000-0000-0000-000000000002','owner-b@gate.test'),
 ('99999999-0000-0000-0000-000000000003','retailer@gate.test'),
 ('99999999-0000-0000-0000-000000000004','staff-a@gate.test'),
 ('99999999-0000-0000-0000-000000000005','manager-a@gate.test'),
 ('99999999-0000-0000-0000-000000000006','super@gate.test'),
 ('99999999-0000-0000-0000-000000000007','staff-b@gate.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('99999999-0000-0000-0000-000000000001','wholesaler','A사장','010'),
 ('99999999-0000-0000-0000-000000000002','wholesaler','B사장','010'),
 ('99999999-0000-0000-0000-000000000003','retailer','식당','010'),
 ('99999999-0000-0000-0000-000000000004','wholesaler','A직원','010'),
 ('99999999-0000-0000-0000-000000000005','wholesaler','A매니저','010'),
 ('99999999-0000-0000-0000-000000000006','super_admin','관리자','010'),
 ('99999999-0000-0000-0000-000000000007','wholesaler','B직원','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a9999999-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','A축산','9990000001','A','active'),
 ('a9999999-0000-0000-0000-000000000002','99999999-0000-0000-0000-000000000002','B축산','9990000002','B','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('09999999-0000-0000-0000-000000000001','a9999999-0000-0000-0000-000000000001','A축산','9990000001'),
 ('09999999-0000-0000-0000-000000000002','a9999999-0000-0000-0000-000000000002','B축산','9990000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('09999999-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000004','staff'),
 ('09999999-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000005','manager'),
 ('09999999-0000-0000-0000-000000000002','99999999-0000-0000-0000-000000000007','staff');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('d9999999-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000003','식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status)
 values ('a9999999-0000-0000-0000-000000000001','d9999999-0000-0000-0000-000000000001','active');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('c9999999-0000-0000-0000-000000000001','a9999999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',10);

-- A사장이 박스 하나를 입고해 둔다(매입단가 수정 대상)
set role authenticated; set request.jwt.claim.sub = '99999999-0000-0000-0000-000000000001';
select public.upsert_master_livestock('009999999901','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.record_inbound_scan('009999999901', 8.000, 'BARCODE_SCAN', 'c9999999-0000-0000-0000-000000000001') -> 'status' as seed_scan_should_be_NORMAL;
create temp table seed as select id as scan_id from public.inbound_scans where trace_no='009999999901' limit 1;

-- ========== 0. 버그의 원인: NULL 비교는 IF에서 거짓으로 취급된다 ==========
select '--- 0. 3치 논리 — 옛 게이트 식이 NULL이 되는 것을 확인 ---' as t;
select ((null::uuid <> gen_random_uuid()) and ('retailer' <> 'super_admin')) is null as old_ownership_gate_was_null,
       ((null::uuid <> null::uuid) and not false)                            is null as old_manage_gate_was_null,
       public.can_access_wholesaler(null) as new_access_null_is_false,
       public.can_manage_wholesaler(null) as new_manage_null_is_false;

-- ========== 1. 고객(식당) 계정 — 전부 거부돼야 한다 ==========
set request.jwt.claim.sub = '99999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('고객','adjust_product_stock(남의 상품 재고 0으로)','DENIED: PRODUCT_NOT_FOUND',
   pg_temp.try($q$select public.adjust_product_stock('c9999999-0000-0000-0000-000000000001', 0, 'STOCKTAKE')$q$)),
 ('고객','set_product_archived(남의 상품 보관)','DENIED: PRODUCT_NOT_FOUND',
   pg_temp.try($q$select public.set_product_archived('c9999999-0000-0000-0000-000000000001', true)$q$)),
 ('고객','update_inbound_purchase(남의 매입단가)','DENIED: SCAN_NOT_FOUND',
   pg_temp.try($q$select public.update_inbound_purchase((select scan_id from seed), 1)$q$)),
 ('고객','set_product_purchase_price','DENIED: NOT_A_SUPPLIER',
   pg_temp.try($q$select public.set_product_purchase_price('c9999999-0000-0000-0000-000000000001', 1)$q$)),
 ('고객','delete_product_bundle','DENIED: NOT_A_SUPPLIER',
   pg_temp.try($q$select public.delete_product_bundle(gen_random_uuid())$q$)),
 ('고객','disassemble_bundle_assembly','DENIED: NOT_A_SUPPLIER',
   pg_temp.try($q$select public.disassemble_bundle_assembly(gen_random_uuid())$q$)),
 ('고객','bulk_update_product_prices','DENIED: NOT_A_SUPPLIER',
   pg_temp.try($q$select public.bulk_update_product_prices('[]'::jsonb)$q$));

-- ========== 2. A사 직원(staff) — 입고는 되고, 관리 행위는 FORBIDDEN ==========
set request.jwt.claim.sub = '99999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('A직원','record_inbound_scan(입고는 허용)','ALLOWED',
   pg_temp.try($q$select public.record_inbound_scan('009999999901', 7.000, 'MANUAL', 'c9999999-0000-0000-0000-000000000001', p_confirm_duplicate => true)$q$)),
 ('A직원','adjust_product_stock','DENIED: FORBIDDEN',
   pg_temp.try($q$select public.adjust_product_stock('c9999999-0000-0000-0000-000000000001', 0, 'STOCKTAKE')$q$)),
 ('A직원','set_product_archived','DENIED: FORBIDDEN',
   pg_temp.try($q$select public.set_product_archived('c9999999-0000-0000-0000-000000000001', true)$q$)),
 ('A직원','update_inbound_purchase','DENIED: FORBIDDEN',
   pg_temp.try($q$select public.update_inbound_purchase((select scan_id from seed), 1)$q$)),
 ('A직원','set_product_purchase_price','DENIED: FORBIDDEN',
   pg_temp.try($q$select public.set_product_purchase_price('c9999999-0000-0000-0000-000000000001', 1)$q$)),
 ('A직원','bulk_update_product_prices','DENIED: FORBIDDEN',
   pg_temp.try($q$select public.bulk_update_product_prices('[]'::jsonb)$q$));

-- ========== 3. B사 직원 — 남의 업체 상품은 존재조차 안 알려준다 ==========
set request.jwt.claim.sub = '99999999-0000-0000-0000-000000000007';
insert into results (who,what,expected,result) values
 ('B직원','adjust_product_stock(A사 상품)','DENIED: PRODUCT_NOT_FOUND',
   pg_temp.try($q$select public.adjust_product_stock('c9999999-0000-0000-0000-000000000001', 0, 'STOCKTAKE')$q$)),
 ('B직원','update_inbound_purchase(A사 박스)','DENIED: SCAN_NOT_FOUND',
   pg_temp.try($q$select public.update_inbound_purchase((select scan_id from seed), 1)$q$));

-- ========== 4. A사 매니저 — 관리 행위 허용 ==========
set request.jwt.claim.sub = '99999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A매니저','adjust_product_stock','ALLOWED',
   pg_temp.try($q$select public.adjust_product_stock('c9999999-0000-0000-0000-000000000001', 20, 'STOCKTAKE')$q$)),
 ('A매니저','update_inbound_purchase','ALLOWED',
   pg_temp.try($q$select public.update_inbound_purchase((select scan_id from seed), 50000)$q$)),
 ('A매니저','set_product_purchase_price','ALLOWED',
   pg_temp.try($q$select public.set_product_purchase_price('c9999999-0000-0000-0000-000000000001', 50000)$q$)),
 ('A매니저','bulk_update_product_prices','ALLOWED',
   pg_temp.try($q$select public.bulk_update_product_prices('[]'::jsonb)$q$));

-- ========== 5. A사장(owner) — 허용 ==========
set request.jwt.claim.sub = '99999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','adjust_product_stock','ALLOWED',
   pg_temp.try($q$select public.adjust_product_stock('c9999999-0000-0000-0000-000000000001', 21, 'STOCKTAKE')$q$)),
 ('A사장','set_product_archived(false)','ALLOWED',
   pg_temp.try($q$select public.set_product_archived('c9999999-0000-0000-0000-000000000001', false)$q$));

-- ========== 6. 슈퍼관리자(조직 미소속) — 감독 권한으로 허용(기존 동작 유지) ==========
set request.jwt.claim.sub = '99999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('슈퍼관리자','adjust_product_stock','ALLOWED',
   pg_temp.try($q$select public.adjust_product_stock('c9999999-0000-0000-0000-000000000001', 22, 'STOCKTAKE')$q$));

-- ========== 7. 엑셀 대량입고 이중 처리 — 같은 업로드 행은 두 번 못 들어간다 ==========
set request.jwt.claim.sub = '99999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','EXCEL 행 첫 입고','ALLOWED',
   pg_temp.try($q$select public.record_inbound_scan('009999999901', 5.000, 'EXCEL', 'c9999999-0000-0000-0000-000000000001', p_import_row_id => 'e9999999-0000-0000-0000-000000000001', p_confirm_duplicate => true)$q$)),
 ('A사장','EXCEL 같은 행 두 번째 입고(다른 창)','DENIED: duplicate key value violates unique constraint "idx_inbound_scans_import_row_unique"',
   pg_temp.try($q$select public.record_inbound_scan('009999999901', 5.000, 'EXCEL', 'c9999999-0000-0000-0000-000000000001', p_import_row_id => 'e9999999-0000-0000-0000-000000000001', p_confirm_duplicate => true)$q$));

-- ========== 결과 ==========
reset role;
select '--- 결과 ---' as t;
select no, who, what, expected, result, case when expected = result then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where expected = result) as pass,
       count(*) filter (where expected <> result) as fail
  from results;

select '--- 고객/직원 시도가 재고·보관 상태를 못 바꿨나 (관리자 조정 22 + 엑셀 입고 5 = 27, 보관 해제) ---' as t;
select stock_quantity as should_be_27, archived_at as should_be_null
  from public.products where id='c9999999-0000-0000-0000-000000000001';

rollback;
