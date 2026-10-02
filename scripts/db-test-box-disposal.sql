-- 박스 단위 폐기(216) — 대표만, 일부/전량, 장부 LOSS 기록, 손실 금액 = 중량 × 매입단가, 이력 불변, 점검(213) 0건 유지.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-box-disposal.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ALLOWED'; exception when others then return 'DENIED: ' || split_part(sqlerrm, ':', 1); end $$;
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return coalesce(v, '<null>'); exception when others then return 'ERROR: ' || split_part(sqlerrm, ':', 1); end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

create function pg_temp.check_counts() returns text language sql as $$
    select coalesce(string_agg(check_key || '=' || violations, ',' order by check_key) filter (where violations > 0 and check_key not in ('boxes_exceed_stock','normal_box_without_ledger')), 'clean')
    from public.stock_integrity_violations('a8888888-0000-0000-0000-000000000001');
$$;

-- 시드: 01 대표 / 02 매니저 / 03 직원 / 04 타사 대표
insert into auth.users (id,email) values
 ('88888888-8888-0000-0000-000000000001','owner@dispose.test'),
 ('88888888-8888-0000-0000-000000000002','manager@dispose.test'),
 ('88888888-8888-0000-0000-000000000003','staff@dispose.test'),
 ('88888888-8888-0000-0000-000000000004','other@dispose.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('88888888-8888-0000-0000-000000000001','wholesaler','대표','010',true,true),
 ('88888888-8888-0000-0000-000000000002','wholesaler','매니저','010',true,true),
 ('88888888-8888-0000-0000-000000000003','wholesaler','직원','010',true,true),
 ('88888888-8888-0000-0000-000000000004','wholesaler','타사대표','010',true,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a8888888-0000-0000-0000-000000000001','88888888-8888-0000-0000-000000000001','폐기축산','8880000001','대표','active'),
 ('a8888888-0000-0000-0000-000000000002','88888888-8888-0000-0000-000000000004','타사축산','8880000002','타사','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('08888888-0000-0000-0000-000000000001','a8888888-0000-0000-0000-000000000001','폐기축산','8880000001'),
 ('08888888-0000-0000-0000-000000000002','a8888888-0000-0000-0000-000000000002','타사축산','8880000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('08888888-0000-0000-0000-000000000001','88888888-8888-0000-0000-000000000001','owner'),
 ('08888888-0000-0000-0000-000000000001','88888888-8888-0000-0000-000000000002','manager'),
 ('08888888-0000-0000-0000-000000000001','88888888-8888-0000-0000-000000000003','staff'),
 ('08888888-0000-0000-0000-000000000002','88888888-8888-0000-0000-000000000004','owner');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('c8888888-0000-0000-0000-000000000001','a8888888-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',10,true);
-- 박스 1: 10kg, 매입단가 40,000, 장부 +10.  박스 2: 단가 없음 4kg, 장부 +4 (상품 재고 합 14).  박스 3: 장부 없는 박스.
update public.products set stock_quantity = 14 where id = 'c8888888-0000-0000-0000-000000000001';
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight,purchase_unit_price) values
 ('b8888888-0000-0000-0000-000000000001','a8888888-0000-0000-0000-000000000001','088800000001',10,'kg','MANUAL','NORMAL','c8888888-0000-0000-0000-000000000001',10,40000),
 ('b8888888-0000-0000-0000-000000000002','a8888888-0000-0000-0000-000000000001','088800000002',4,'kg','MANUAL','NORMAL','c8888888-0000-0000-0000-000000000001',4,null),
 ('b8888888-0000-0000-0000-000000000003','a8888888-0000-0000-0000-000000000001','088800000003',3,'kg','MANUAL','NORMAL','c8888888-0000-0000-0000-000000000001',3,1000);
-- 박스 3은 장부 기록이 없다 — 이 시드 때문에 생기는 점검 항목 2개(boxes_exceed_stock·normal_box_without_ledger)는 아래 점검 비교에서 뺀다
insert into public.stock_ledger (wholesaler_id,product_id,inbound_scan_id,qty_delta,event_type,source_type,source_id) values
 ('a8888888-0000-0000-0000-000000000001','c8888888-0000-0000-0000-000000000001','b8888888-0000-0000-0000-000000000001',10,'INBOUND','inbound_scan','b8888888-0000-0000-0000-000000000001'),
 ('a8888888-0000-0000-0000-000000000001','c8888888-0000-0000-0000-000000000001','b8888888-0000-0000-0000-000000000002',4,'INBOUND','inbound_scan','b8888888-0000-0000-0000-000000000002');

set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '88888888-8888-0000-0000-000000000001';

-- ========== 거부 사유 ==========
insert into results (who,what,expected,result) values
 ('대표','중량 0 → 거부','DENIED: INVALID_WEIGHT', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',0,'DAMAGE',null,10)$q$)),
 ('대표','소수 4자리 → 거부','DENIED: INVALID_WEIGHT', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',1.0001,'DAMAGE',null,10)$q$)),
 ('대표','알 수 없는 사유 → 거부','DENIED: INVALID_REASON', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',1,'WHATEVER',null,10)$q$)),
 ('대표','기타 사유인데 메모 없음 → 거부','DENIED: NOTE_REQUIRED', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',1,'OTHER',' ',10)$q$)),
 ('대표','잔량(10)보다 많이 → 거부','DENIED: OVER_REMAINING', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',10.001,'DAMAGE',null,10)$q$)),
 ('대표','화면이 본 잔량(9)과 다르면 → STALE','DENIED: STALE', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',1,'DAMAGE',null,9)$q$)),
 ('대표','장부 기록 없는 박스 → 거부','DENIED: NO_LEDGER', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000003',1,'DAMAGE',null,3)$q$)),
 ('대표','없는 박스 → 거부','DENIED: TARGET_NOT_FOUND', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-0000000000ff',1,'DAMAGE',null,3)$q$));

-- ========== 일부 폐기: 2.5kg × 40,000 = 100,000원 ==========
insert into results (who,what,expected,result) values
 ('대표','박스 일부(2.5kg) 폐기 → 허용','ALLOWED', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',2.5,'EXPIRED',null,10)$q$)),
 ('대표','박스 잔량 10 → 7.5','7.500', pg_temp.val($q$select remaining_weight::text from public.inbound_scans where id='b8888888-0000-0000-0000-000000000001'$q$)),
 ('대표','상품 재고 14 → 11.5','11.500', pg_temp.val($q$select stock_quantity::text from public.products where id='c8888888-0000-0000-0000-000000000001'$q$)),
 ('대표','장부에 LOSS −2.5가 그 박스로 한 줄','1|-2.500', pg_temp.val($q$select count(*)||'|'||min(qty_delta) from public.stock_ledger where inbound_scan_id='b8888888-0000-0000-0000-000000000001' and event_type='LOSS'$q$)),
 ('대표','이력: 손실 금액 100000, 단가 40000','100000|40000', pg_temp.val($q$select loss_amount::text||'|'||unit_price::numeric(14,0)::text from public.list_box_disposals() limit 1$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','폐기 후 재고 점검(213)은 0건','clean', pg_temp.check_counts());
set role authenticated; set request.jwt.claim.sub = '88888888-8888-0000-0000-000000000001';

-- ========== 전량 폐기, 단가 모르는 박스 → 금액 NULL ==========
insert into results (who,what,expected,result) values
 ('대표','단가 없는 박스 전량(4kg) 폐기 → 허용','ALLOWED', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000002',4,'SPOILED',null,4)$q$)),
 ('대표','박스 잔량 0','0.000', pg_temp.val($q$select remaining_weight::text from public.inbound_scans where id='b8888888-0000-0000-0000-000000000002'$q$)),
 ('대표','단가를 모르면 손실 금액은 비어 있다(수량만 기록)','<null>', pg_temp.val($q$select loss_amount::text from public.list_box_disposals() where trace_no='088800000002'$q$)),
 ('대표','이미 비운 박스를 또 폐기 → 거부','DENIED: OVER_REMAINING', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000002',1,'SPOILED',null,0)$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','전량 폐기 후에도 점검 0건','clean', pg_temp.check_counts());

-- ========== 권한 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '88888888-8888-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('매니저','폐기·이력 조회 → 거부(대표 전용)','DENIED: NOT_OWNER|DENIED: NOT_OWNER', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',1,'DAMAGE',null,7.5)$q$)||'|'||pg_temp.try($q$select * from public.list_box_disposals()$q$));
set request.jwt.claim.sub = '88888888-8888-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('직원','폐기 → 거부','DENIED: NOT_OWNER', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',1,'DAMAGE',null,7.5)$q$));
set request.jwt.claim.sub = '88888888-8888-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('타사 대표','남의 업체 박스 폐기 → 거부','DENIED: TARGET_NOT_FOUND', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',1,'DAMAGE',null,7.5)$q$)),
 ('타사 대표','타사 대표의 폐기 이력에는 우리 업체 기록이 없다','0', pg_temp.val($q$select count(*)::text from public.list_box_disposals()$q$));
set request.jwt.claim.sub = '88888888-8888-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','폐기 이력 조회: 2건','2', pg_temp.val($q$select count(*)::text from public.list_box_disposals()$q$)),
 ('대표','이력 표에 직접 쓰기·고치기·지우기 → 거부','DENIED|DENIED|DENIED', pg_temp.try($q$insert into public.box_disposals (wholesaler_id,inbound_scan_id,trace_no,reason_code,weight,before_remaining,after_remaining) values ('a8888888-0000-0000-0000-000000000001','b8888888-0000-0000-0000-000000000001','x','OTHER',1,1,0)$q$)||'|'||pg_temp.try($q$update public.box_disposals set note='바꿈'$q$)||'|'||pg_temp.try($q$delete from public.box_disposals$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','폐기·이력 호출 → 거부','DENIED|DENIED', pg_temp.try($q$select public.dispose_box('b8888888-0000-0000-0000-000000000001',1,'DAMAGE',null,7.5)$q$)||'|'||pg_temp.try($q$select * from public.list_box_disposals()$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','서버 권한으로도 이력은 고칠 수 없다(트리거)','DENIED: HISTORY_IMMUTABLE', pg_temp.try($q$update public.box_disposals set note='위조'$q$));

-- 220: 다른 업체의 박스를 가리키는 이력은 서버 권한으로도 쓸 수 없다(공급사 섞임 방어)
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,remaining_weight)
values ('b8888888-0000-0000-0000-0000000000b2','a8888888-0000-0000-0000-000000000002','088800000099',5,'kg','MANUAL','NORMAL',5);
insert into results (who,what,expected,result) values
 ('시스템','우리 업체 이력이 타사 박스를 가리키면 → 거부(섞임 방어)','DENIED', pg_temp.try($q$insert into public.box_disposals (wholesaler_id,inbound_scan_id,trace_no,reason_code,weight,before_remaining,after_remaining) values ('a8888888-0000-0000-0000-000000000001','b8888888-0000-0000-0000-0000000000b2','088800000099','DAMAGE',1,5,4)$q$)),
 ('시스템','같은 업체 박스를 가리키는 이력은 정상 대조군으로 쓸 수 있다','ALLOWED', pg_temp.try($q$insert into public.box_disposals (wholesaler_id,inbound_scan_id,trace_no,reason_code,weight,before_remaining,after_remaining) values ('a8888888-0000-0000-0000-000000000001','b8888888-0000-0000-0000-000000000001','088800000001','DAMAGE',1,5,4)$q$));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected like 'DENIED|%' and result like 'DENIED%') or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected like 'DENIED|%' and result like 'DENIED%') or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected like 'DENIED|%' and result like 'DENIED%') or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
