-- 재고 점검 보정(215) — 업체 대표가 어긋난 상품 재고·박스 잔량을 "장부 기준" 또는 "실물 기준"으로 고친다.
-- 입출고 기록은 고치지 않고 보정 기록만 쌓이며, 고친 뒤에는 점검(213)이 0건이어야 한다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-stock-repair.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ALLOWED'; exception when others then return 'DENIED: ' || split_part(sqlerrm, ':', 1); end $$;
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return coalesce(v, '<null>'); exception when others then return 'ERROR: ' || split_part(sqlerrm, ':', 1); end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- 점검(213)을 이 업체로 좁혀 "키=건수" 문자열로
create function pg_temp.check_counts() returns text language sql as $$
    select string_agg(check_key || '=' || violations, ',' order by check_key)
    from public.stock_integrity_violations('a7777777-0000-0000-0000-000000000001');
$$;
create function pg_temp.sum_ledger_box(p_box uuid) returns text language sql as $$
    select coalesce(sum(qty_delta), 0)::text from public.stock_ledger where inbound_scan_id = p_box;
$$;

-- 시드: 01 대표 / 02 매니저 / 03 직원 / 04 타사 대표
insert into auth.users (id,email) values
 ('77777777-7777-0000-0000-000000000001','owner@repair.test'),
 ('77777777-7777-0000-0000-000000000002','manager@repair.test'),
 ('77777777-7777-0000-0000-000000000003','staff@repair.test'),
 ('77777777-7777-0000-0000-000000000004','other@repair.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('77777777-7777-0000-0000-000000000001','wholesaler','대표','010',true,true),
 ('77777777-7777-0000-0000-000000000002','wholesaler','매니저','010',true,true),
 ('77777777-7777-0000-0000-000000000003','wholesaler','직원','010',true,true),
 ('77777777-7777-0000-0000-000000000004','wholesaler','타사대표','010',true,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a7777777-0000-0000-0000-000000000001','77777777-7777-0000-0000-000000000001','보정축산','7770000001','대표','active'),
 ('a7777777-0000-0000-0000-000000000002','77777777-7777-0000-0000-000000000004','타사축산','7770000002','타사','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('07777777-0000-0000-0000-000000000001','a7777777-0000-0000-0000-000000000001','보정축산','7770000001'),
 ('07777777-0000-0000-0000-000000000002','a7777777-0000-0000-0000-000000000002','타사축산','7770000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('07777777-0000-0000-0000-000000000001','77777777-7777-0000-0000-000000000001','owner'),
 ('07777777-0000-0000-0000-000000000001','77777777-7777-0000-0000-000000000002','manager'),
 ('07777777-0000-0000-0000-000000000001','77777777-7777-0000-0000-000000000003','staff'),
 ('07777777-0000-0000-0000-000000000002','77777777-7777-0000-0000-000000000004','owner');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('c7777777-0000-0000-0000-000000000001','a7777777-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',10,true),
 ('c7777777-0000-0000-0000-000000000002','a7777777-0000-0000-0000-000000000001','박스 없는 상품','돼지','삼겹살','국내산',null,20000,'kg',8,true),
 ('c7777777-0000-0000-0000-000000000009','a7777777-0000-0000-0000-000000000002','타사 상품','돼지','목살','국내산',null,15000,'kg',5,true);
-- 박스 하나: 입고 10kg(원장 +10), 잔량 10, 매입단가 40,000. 상품 재고 10 = 원장 10.
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight,purchase_unit_price) values
 ('b7777777-0000-0000-0000-000000000001','a7777777-0000-0000-0000-000000000001','077700000001',10,'kg','MANUAL','NORMAL','c7777777-0000-0000-0000-000000000001',10,40000),
 ('b7777777-0000-0000-0000-000000000002','a7777777-0000-0000-0000-000000000001','077700000002',5,'kg','MANUAL','PENDING_MAPPING',null,5,null);
insert into public.stock_ledger (wholesaler_id,product_id,inbound_scan_id,qty_delta,event_type,source_type,source_id) values
 ('a7777777-0000-0000-0000-000000000001','c7777777-0000-0000-0000-000000000001','b7777777-0000-0000-0000-000000000001',10,'INBOUND','inbound_scan','b7777777-0000-0000-0000-000000000001');
-- 타사 데이터(건드리면 안 된다)
insert into public.stock_ledger (wholesaler_id,product_id,qty_delta,event_type,source_type) values
 ('a7777777-0000-0000-0000-000000000002','c7777777-0000-0000-0000-000000000009',3,'ADJUSTMENT','manual');

set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';

-- ========== 어긋남이 없으면 목록이 비어 있다 ==========
insert into results (who,what,expected,result) values
 ('대표','정상이면 어긋난 항목이 없다','0', pg_temp.val($q$select count(*)::text from public.list_stock_mismatches()$q$));

-- ========== 상품 재고 어긋남 → 장부 기준 ==========
reset role;
update public.products set stock_quantity = 11 where id = 'c7777777-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','상품 재고 11 ≠ 장부 10 → 목록에 상품 1건, 차이 +1','1|product|1.000', pg_temp.val($q$select count(*)||'|'||min(kind)||'|'||min(diff) from public.list_stock_mismatches()$q$)),
 ('대표','화면이 본 값과 다르게 요청하면(장부 9로 착각) → STALE','DENIED: STALE', pg_temp.try($q$select public.repair_stock_mismatch('product','c7777777-0000-0000-0000-000000000001','LEDGER',null,'확인',11,9)$q$)),
 ('대표','사유 없이 요청 → 거부','DENIED: REASON_REQUIRED', pg_temp.try($q$select public.repair_stock_mismatch('product','c7777777-0000-0000-0000-000000000001','LEDGER',null,'  ',11,10)$q$)),
 ('대표','"장부가 맞다"로 보정 → 허용','ALLOWED', pg_temp.try($q$select public.repair_stock_mismatch('product','c7777777-0000-0000-0000-000000000001','LEDGER',null,'숫자 불일치 확인, 장부 기준',11,10)$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','상품 재고가 장부(10)로 돌아오고, 원장 행은 늘지 않았다(입출고 기록 그대로)','10.000|1', (select stock_quantity::text from public.products where id='c7777777-0000-0000-0000-000000000001') || '|' || (select count(*)::text from public.stock_ledger where product_id='c7777777-0000-0000-0000-000000000001')),
 ('시스템','보정 이력 1건: 상품·장부 기준·전 11·장부 10·후 10','product|LEDGER|11.000|10.000|10.000', (select kind||'|'||basis||'|'||before_current||'|'||before_ledger||'|'||after_value from public.stock_repairs where target_id='c7777777-0000-0000-0000-000000000001')),
 ('시스템','고친 뒤 점검 전부 0','box_over_weight=0,box_remaining_vs_ledger=0,boxes_exceed_stock=0,normal_box_without_ledger=0,product_stock_vs_ledger=0,voided_box_with_remaining=0', pg_temp.check_counts());

-- ========== 상품 어긋남 → 실물 기준 (박스가 있는 상품은 박스 합계보다 적게는 못 맞춘다) ==========
update public.products set stock_quantity = 11 where id = 'c7777777-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','남은 박스가 10kg인 상품을 실물 8.5kg로 맞추려 하면 → 박스 단위로 보정하라며 거부','DENIED: ACTUAL_BELOW_BOXES', pg_temp.try($q$select public.repair_stock_mismatch('product','c7777777-0000-0000-0000-000000000001','ACTUAL',8.5,'실사',11,10)$q$)),
 ('대표','음수 실사 수량 → 거부','DENIED: INVALID_ACTUAL', pg_temp.try($q$select public.repair_stock_mismatch('product','c7777777-0000-0000-0000-000000000001','ACTUAL',-1,'실사',11,10)$q$)),
 ('대표','실물 12kg(박스 10 + 박스 없는 재고 2)로 보정 → 허용','ALLOWED', pg_temp.try($q$select public.repair_stock_mismatch('product','c7777777-0000-0000-0000-000000000001','ACTUAL',12,'박스 없는 재고 2kg 실사',11,10)$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','장부에 보정 기록(+2, ADJUSTMENT, 사유 포함)이 추가되고 재고 12','ADJUSTMENT|2.000|true|12.000', (select event_type||'|'||qty_delta||'|'||(reason like '%박스 없는 재고 2kg 실사%')::text||'|'||(select stock_quantity::text from public.products where id='c7777777-0000-0000-0000-000000000001') from public.stock_ledger where product_id='c7777777-0000-0000-0000-000000000001' and event_type='ADJUSTMENT')),
 ('시스템','점검 전부 0(박스 합계 10 ≤ 재고 12)','box_over_weight=0,box_remaining_vs_ledger=0,boxes_exceed_stock=0,normal_box_without_ledger=0,product_stock_vs_ledger=0,voided_box_with_remaining=0', pg_temp.check_counts());

-- ========== 박스 잔량 어긋남 → 장부 기준 ==========
update public.inbound_scans set remaining_weight = 9 where id = 'b7777777-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','박스 잔량 9 ≠ 장부 10 → 목록에 박스 1건(차이 -1, 단가 40,000)','1|box|-1.000|40000.00', pg_temp.val($q$select count(*)||'|'||min(kind)||'|'||min(diff)||'|'||min(unit_price) from public.list_stock_mismatches() where kind='box'$q$)),
 ('대표','"장부가 맞다"로 보정 → 허용','ALLOWED', pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','LEDGER',null,'잔량 오기 확인',9,10)$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','박스 잔량이 10으로 복구, 금액 영향 = (10-9)kg × 40,000 = +40,000','10.000|40000', (select remaining_weight::text from public.inbound_scans where id='b7777777-0000-0000-0000-000000000001') || '|' || (select valuation_change::text from public.stock_repairs where target_id='b7777777-0000-0000-0000-000000000001'));

-- ========== 박스 잔량 어긋남 → 실물 기준 ==========
update public.inbound_scans set remaining_weight = 9 where id = 'b7777777-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','입고 중량(10)보다 큰 실물(11) → 거부','DENIED: ACTUAL_OVER_WEIGHT', pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','ACTUAL',11,'실사',9,10)$q$)),
 ('대표','실물 7.5kg로 보정 → 허용','ALLOWED', pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','ACTUAL',7.5,'실사: 박스 7.5kg 확인',9,10)$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','박스 잔량 7.5, 그 박스의 장부 합계도 7.5(보정 -2.5가 박스에 붙음)','7.500|7.500', (select remaining_weight::text from public.inbound_scans where id='b7777777-0000-0000-0000-000000000001') || '|' || pg_temp.sum_ledger_box('b7777777-0000-0000-0000-000000000001')),
 ('시스템','상품 재고는 장부 합계를 따라 12 - 2.5 = 9.5','9.500', (select stock_quantity::text from public.products where id='c7777777-0000-0000-0000-000000000001')),
 ('시스템','금액 영향 = (7.5-9)kg × 40,000 = -60,000(재고 평가금액이 줄어든 만큼)','-60000', (select valuation_change::text from public.stock_repairs where target_id='b7777777-0000-0000-0000-000000000001' and basis='ACTUAL')),
 ('시스템','점검 전부 0','box_over_weight=0,box_remaining_vs_ledger=0,boxes_exceed_stock=0,normal_box_without_ledger=0,product_stock_vs_ledger=0,voided_box_with_remaining=0', pg_temp.check_counts());

-- ========== 1그램 어긋남도 고친다 ==========
update public.inbound_scans set remaining_weight = 7.501 where id = 'b7777777-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','박스 잔량 7.501 ≠ 장부 7.500(1그램) → 장부 기준 보정 허용','ALLOWED', pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','LEDGER',null,'1그램 차이',7.501,7.5)$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','1그램 차이가 장부 값으로 돌아왔다','7.500', (select remaining_weight::text from public.inbound_scans where id='b7777777-0000-0000-0000-000000000001'));

-- ========== 거부해야 하는 경우 ==========
set role authenticated; set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','어긋나지 않은 항목을 보정하려 하면 → NOT_MISMATCHED','DENIED: NOT_MISMATCHED', pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','LEDGER',null,'확인',7.5,7.5)$q$)),
 ('대표','장부 기록이 없는 박스(확인 필요 박스) → NO_LEDGER','DENIED: NO_LEDGER', pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000002','LEDGER',null,'확인',5,0)$q$)),
 ('대표','원장 도입 전 수동 재고 상품(원장 행 없음) → NO_LEDGER','DENIED: NO_LEDGER', pg_temp.try($q$select public.repair_stock_mismatch('product','c7777777-0000-0000-0000-000000000002','LEDGER',null,'확인',8,0)$q$)),
 ('대표','타사 상품을 보정하려 하면 → TARGET_NOT_FOUND','DENIED: TARGET_NOT_FOUND', pg_temp.try($q$select public.repair_stock_mismatch('product','c7777777-0000-0000-0000-000000000009','LEDGER',null,'확인',5,3)$q$)),
 ('대표','알 수 없는 종류·기준 → 거부','DENIED: INVALID_KIND|DENIED: INVALID_BASIS', pg_temp.try($q$select public.repair_stock_mismatch('order','c7777777-0000-0000-0000-000000000001','LEDGER',null,'확인',1,1)$q$)||'|'||pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','MAGIC',null,'확인',1,1)$q$));

-- ========== 입출고 기록 조회(근거) ==========
set role authenticated; set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','박스의 입출고 기록: 입고 +10과 보정 기록까지 2건 이상','true|true', pg_temp.val($q$select (count(*) >= 2)::text||'|'||bool_or(event_type='INBOUND' and qty_delta=10)::text from public.list_stock_movements('box','b7777777-0000-0000-0000-000000000001')$q$)),
 ('대표','상품의 입출고 기록도 본다','true', pg_temp.val($q$select (count(*) >= 1)::text from public.list_stock_movements('product','c7777777-0000-0000-0000-000000000001')$q$)),
 ('대표','타사 박스·상품 기록은 못 본다','DENIED: TARGET_NOT_FOUND|DENIED: TARGET_NOT_FOUND', pg_temp.try($q$select * from public.list_stock_movements('product','c7777777-0000-0000-0000-000000000009')$q$)||'|'||pg_temp.try($q$select * from public.list_stock_movements('box','b7777777-0000-0000-0000-0000000000ff')$q$)),
 ('대표','알 수 없는 종류 → 거부','DENIED: INVALID_KIND', pg_temp.try($q$select * from public.list_stock_movements('order','c7777777-0000-0000-0000-000000000001')$q$));
set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('매니저','입출고 기록 조회 → 거부(대표 전용)','DENIED: NOT_OWNER', pg_temp.try($q$select * from public.list_stock_movements('box','b7777777-0000-0000-0000-000000000001')$q$));

-- ========== 권한: 대표만 ==========
set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('매니저','목록·보정·이력 조회 → 거부','DENIED: NOT_OWNER|DENIED: NOT_OWNER|DENIED: NOT_OWNER', pg_temp.try($q$select * from public.list_stock_mismatches()$q$)||'|'||pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','LEDGER',null,'확인',7.5,7.5)$q$)||'|'||pg_temp.try($q$select * from public.list_stock_repairs()$q$));
set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('직원','목록·보정 → 거부','DENIED: NOT_OWNER|DENIED: NOT_OWNER', pg_temp.try($q$select * from public.list_stock_mismatches()$q$)||'|'||pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','LEDGER',null,'확인',7.5,7.5)$q$));
set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('타사 대표','남의 업체 박스를 보정하려 하면 → 거부(자기 업체 것이 아님)','DENIED: TARGET_NOT_FOUND', pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','LEDGER',null,'확인',7.5,7.5)$q$)),
 ('타사 대표','타사 대표의 보정 이력에는 우리 업체 기록이 없다','0', pg_temp.val($q$select count(*)::text from public.list_stock_repairs()$q$));
set request.jwt.claim.sub = '77777777-7777-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','보정 이력 조회: 5건(상품 2·박스 3), 최신순, 한 건에 대표 이름이 붙는다','5|대표', pg_temp.val($q$select count(*)||'|'||min(repaired_by_name) from public.list_stock_repairs()$q$)),
 ('대표','이력 표에 직접 쓰기·고치기·지우기 → 거부','DENIED|DENIED|DENIED', pg_temp.try($q$insert into public.stock_repairs (wholesaler_id,kind,target_id,target_label,basis,before_current,before_ledger,after_value,reason) values ('a7777777-0000-0000-0000-000000000001','box','b7777777-0000-0000-0000-000000000001','x','LEDGER',1,1,1,'x')$q$)||'|'||pg_temp.try($q$update public.stock_repairs set reason='바꿈'$q$)||'|'||pg_temp.try($q$delete from public.stock_repairs$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','목록·보정 호출 → 거부','DENIED|DENIED', pg_temp.try($q$select * from public.list_stock_mismatches()$q$)||'|'||pg_temp.try($q$select public.repair_stock_mismatch('box','b7777777-0000-0000-0000-000000000001','LEDGER',null,'확인',1,1)$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','서버 권한으로도 이력은 고칠 수 없다(트리거)','DENIED: HISTORY_IMMUTABLE', pg_temp.try($q$update public.stock_repairs set reason='위조'$q$)),
 ('시스템','타사 상품은 건드리지 않았다(재고 5 그대로 — 일부러 장부 3과 다르게 둔 값이라, 보정이 남의 업체에 번지지 않았다는 증거)','5.000', (select stock_quantity::text || '' from public.products where id='c7777777-0000-0000-0000-000000000009') );

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected like 'DENIED|%' and result like 'DENIED%') or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected like 'DENIED|%' and result like 'DENIED%') or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected like 'DENIED|%' and result like 'DENIED%') or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
