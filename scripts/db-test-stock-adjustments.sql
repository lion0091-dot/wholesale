-- 회계 관리 > 재고 조정·손실 탭(218) — 대표 전용 조회, 손실 금액은 박스 폐기만 안다, 단위별 합계, 탭·메뉴 끄기.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-stock-adjustments.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ALLOWED'; exception when others then return 'DENIED: ' || split_part(sqlerrm, ':', 1); end $$;
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return coalesce(v, '<null>'); exception when others then return 'ERROR: ' || split_part(sqlerrm, ':', 1); end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- 시드: 01 대표 / 02 매니저 / 03 직원 / 04 타사 대표
insert into auth.users (id,email) values
 ('89999999-8999-0000-0000-000000000001','owner@adj.test'),
 ('89999999-8999-0000-0000-000000000002','manager@adj.test'),
 ('89999999-8999-0000-0000-000000000003','staff@adj.test'),
 ('89999999-8999-0000-0000-000000000004','other@adj.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('89999999-8999-0000-0000-000000000001','wholesaler','대표','010',true,true),
 ('89999999-8999-0000-0000-000000000002','wholesaler','매니저','010',true,true),
 ('89999999-8999-0000-0000-000000000003','wholesaler','직원','010',true,true),
 ('89999999-8999-0000-0000-000000000004','wholesaler','타사대표','010',true,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a8999999-0000-0000-0000-000000000001','89999999-8999-0000-0000-000000000001','조정축산','8990000001','대표','active'),
 ('a8999999-0000-0000-0000-000000000002','89999999-8999-0000-0000-000000000004','타사축산','8990000002','타사','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('08999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001','조정축산','8990000001'),
 ('08999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000002','타사축산','8990000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('08999999-0000-0000-0000-000000000001','89999999-8999-0000-0000-000000000001','owner'),
 ('08999999-0000-0000-0000-000000000001','89999999-8999-0000-0000-000000000002','manager'),
 ('08999999-0000-0000-0000-000000000001','89999999-8999-0000-0000-000000000003','staff'),
 ('08999999-0000-0000-0000-000000000002','89999999-8999-0000-0000-000000000004','owner');
-- 상품 1(kg, 재고 14 = 박스 10 + 4), 상품 2(개, 재고 5, 박스 없음), 타사 상품
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('c8999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',14,true),
 ('c8999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000001','계란','닭','계란','국내산',null,5000,'개',5,true),
 ('c8999999-0000-0000-0000-000000000003','a8999999-0000-0000-0000-000000000002','타사 등심','소','등심','국내산','1++',68000,'kg',10,true);
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight,purchase_unit_price) values
 ('b8999999-0000-0000-0000-000000000001','a8999999-0000-0000-0000-000000000001','089900000001',10,'kg','MANUAL','NORMAL','c8999999-0000-0000-0000-000000000001',10,40000),
 ('b8999999-0000-0000-0000-000000000002','a8999999-0000-0000-0000-000000000001','089900000002',4,'kg','MANUAL','NORMAL','c8999999-0000-0000-0000-000000000001',4,null),
 ('b8999999-0000-0000-0000-000000000003','a8999999-0000-0000-0000-000000000002','089900000003',10,'kg','MANUAL','NORMAL','c8999999-0000-0000-0000-000000000003',10,30000);
insert into public.stock_ledger (wholesaler_id,product_id,inbound_scan_id,qty_delta,event_type,source_type,source_id) values
 ('a8999999-0000-0000-0000-000000000001','c8999999-0000-0000-0000-000000000001','b8999999-0000-0000-0000-000000000001',10,'INBOUND','inbound_scan','b8999999-0000-0000-0000-000000000001'),
 ('a8999999-0000-0000-0000-000000000001','c8999999-0000-0000-0000-000000000001','b8999999-0000-0000-0000-000000000002',4,'INBOUND','inbound_scan','b8999999-0000-0000-0000-000000000002'),
 ('a8999999-0000-0000-0000-000000000002','c8999999-0000-0000-0000-000000000003','b8999999-0000-0000-0000-000000000003',10,'INBOUND','inbound_scan','b8999999-0000-0000-0000-000000000003');

set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '89999999-8999-0000-0000-000000000001';

-- 실제 업무 경로로 기록을 만든다: 박스 폐기 2건 + 상품 단위 조정 4건
select public.dispose_box('b8999999-0000-0000-0000-000000000001', 2.5, 'EXPIRED', null, 10);   -- 100,000원 (2.5kg x 40,000)
select public.dispose_box('b8999999-0000-0000-0000-000000000002', 1, 'DAMAGE', null, 4);       -- 단가 없음 → 금액 미상 1kg
select public.adjust_product_stock('c8999999-0000-0000-0000-000000000001', 10.0, 'DISPOSAL');  -- 11.5 → 10: LOSS 0.5kg (상품 단위, 금액 없음)
select public.adjust_product_stock('c8999999-0000-0000-0000-000000000001', 12.0, 'RETURN');    -- +2 ADJUSTMENT
select public.adjust_product_stock('c8999999-0000-0000-0000-000000000001', 11.0, 'STOCKTAKE'); -- -1 ADJUSTMENT
select public.adjust_product_stock('c8999999-0000-0000-0000-000000000002', 3, 'DAMAGE');       -- 5 → 3: LOSS 2개 (다른 단위)

-- ========== 대표: 목록 ==========
insert into results (who,what,expected,result) values
 ('대표','전체 기록 6건(손실 4 + 조정 2), 입고·기초재고는 안 섞인다','6|4|2', pg_temp.val($q$select (select count(*) from public.list_stock_adjustments())||'|'||(select count(*) from public.list_stock_adjustments(null,null,'LOSS'))||'|'||(select count(*) from public.list_stock_adjustments(null,null,'ADJUSTMENT'))$q$)),
 ('대표','박스 폐기 줄: 손실 금액 100,000원·단가 40,000·박스번호·부호는 음수','-2.500|100000|40000.00|089900000001', pg_temp.val($q$select qty_delta::text||'|'||loss_amount::text||'|'||unit_price::text||'|'||trace_no from public.list_stock_adjustments() where trace_no='089900000001'$q$)),
 ('대표','단가 없는 박스 폐기와 상품 단위 조정은 금액이 비어 있다(0원이 아니다)','3', pg_temp.val($q$select count(*)::text from public.list_stock_adjustments(null,null,'LOSS') where loss_amount is null$q$)),
 ('대표','알 수 없는 종류 → 거부','DENIED: INVALID_KIND', pg_temp.try($q$select * from public.list_stock_adjustments(null,null,'INBOUND')$q$)),
 ('대표','미래 날짜부터 → 0건 / 오늘까지 → 6건(한국 시간 기준 끝 날짜 포함)','0|6', pg_temp.val($q$select (select count(*) from public.list_stock_adjustments(((now() at time zone 'Asia/Seoul')::date + 1)))||'|'||(select count(*) from public.list_stock_adjustments(null,((now() at time zone 'Asia/Seoul')::date)))$q$)),
 ('대표','만든 사람 이름이 보인다','대표', pg_temp.val($q$select distinct by_name from public.list_stock_adjustments()$q$));

-- ========== 대표: 합계(단위별) ==========
insert into results (who,what,expected,result) values
 ('대표','단위가 둘(kg·개)이라 합계 줄도 둘','2', pg_temp.val($q$select count(*)::text from public.summarize_stock_adjustments()$q$)),
 ('대표','kg: 5건 / 손실 4.000 / 금액 100,000 / 금액 미상 1.500 / 조정 +2.000 −1.000','5|4.000|100000|1.500|2.000|1.000', pg_temp.val($q$select event_count||'|'||loss_qty||'|'||loss_amount||'|'||loss_unpriced_qty||'|'||adjust_in_qty||'|'||adjust_out_qty from public.summarize_stock_adjustments() where unit='kg'$q$)),
 ('대표','개: 1건 / 손실 2.000 / 금액 0(미상 2.000) / 조정 0','1|2.000|0|2.000|0|0', pg_temp.val($q$select event_count||'|'||loss_qty||'|'||loss_amount||'|'||loss_unpriced_qty||'|'||adjust_in_qty||'|'||adjust_out_qty from public.summarize_stock_adjustments() where unit='개'$q$)),
 ('대표','미래 날짜 구간의 합계 → 줄 없음','0', pg_temp.val($q$select count(*)::text from public.summarize_stock_adjustments(((now() at time zone 'Asia/Seoul')::date + 1))$q$));

-- ========== 권한 ==========
set request.jwt.claim.sub = '89999999-8999-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('매니저','목록·합계 → 거부(대표 전용)','DENIED: NOT_OWNER|DENIED: NOT_OWNER', pg_temp.try($q$select * from public.list_stock_adjustments()$q$)||'|'||pg_temp.try($q$select * from public.summarize_stock_adjustments()$q$));
set request.jwt.claim.sub = '89999999-8999-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('직원','목록·합계 → 거부','DENIED: NOT_OWNER|DENIED: NOT_OWNER', pg_temp.try($q$select * from public.list_stock_adjustments()$q$)||'|'||pg_temp.try($q$select * from public.summarize_stock_adjustments()$q$));
set request.jwt.claim.sub = '89999999-8999-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('타사 대표','자기 업체 기록만 본다(조정축산 기록 0건, 합계 0줄)','0|0', pg_temp.val($q$select count(*)::text from public.list_stock_adjustments()$q$)||'|'||pg_temp.val($q$select count(*)::text from public.summarize_stock_adjustments()$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','목록·합계 → 거부','DENIED|DENIED', pg_temp.try($q$select * from public.list_stock_adjustments()$q$)||'|'||pg_temp.try($q$select * from public.summarize_stock_adjustments()$q$));

-- ========== 탭·메뉴 끄기 ==========
reset role;
insert into public.wholesaler_features (wholesaler_id, feature_key, enabled) values
 ('a8999999-0000-0000-0000-000000000001', 'accounting_stock_adjust', false);
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '89999999-8999-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(탭 꺼짐)','목록·합계 → 거부','DENIED: FEATURE_DISABLED|DENIED: FEATURE_DISABLED', pg_temp.try($q$select * from public.list_stock_adjustments()$q$)||'|'||pg_temp.try($q$select * from public.summarize_stock_adjustments()$q$)),
 ('대표(탭 꺼짐)','다른 업무(박스 폐기·재고 조정)는 영향 없다','ALLOWED|ALLOWED', pg_temp.try($q$select public.dispose_box('b8999999-0000-0000-0000-000000000001', 0.5, 'DAMAGE', null, 7.5)$q$)||'|'||pg_temp.try($q$select public.adjust_product_stock('c8999999-0000-0000-0000-000000000001', 9, 'STOCKTAKE')$q$));
reset role;
delete from public.wholesaler_features where wholesaler_id='a8999999-0000-0000-0000-000000000001' and feature_key='accounting_stock_adjust';
insert into public.wholesaler_features (wholesaler_id, feature_key, enabled) values
 ('a8999999-0000-0000-0000-000000000001', 'accounting', false);
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '89999999-8999-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(메뉴 꺼짐)','탭 자체는 켜져 있어도 회계 관리 메뉴가 꺼지면 거부','DENIED: FEATURE_DISABLED', pg_temp.try($q$select * from public.list_stock_adjustments()$q$));
reset role;
delete from public.wholesaler_features where wholesaler_id='a8999999-0000-0000-0000-000000000001' and feature_key='accounting';
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '89999999-8999-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(복구)','다시 켜면 기록이 돌아온다(위에서 한 조정·폐기까지 8건)','8', pg_temp.val($q$select count(*)::text from public.list_stock_adjustments()$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','탭 키가 회계 관리 아래에 등록돼 있다','accounting', (select parent_key from public.platform_features where key='accounting_stock_adjust'));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%'))) as fail
  from results;
