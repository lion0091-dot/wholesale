-- 회계 관리 > 계산서 집계 탭(222) — 발행 완료 최초 발행만 금액 합산, 정정은 건수만, 진행 중·실패 분리, 취소 제외, 월별·거래처별, 대표·매니저만, 탭·메뉴 끄기.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-tax-invoice-summary.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ALLOWED'; exception when others then return 'DENIED: ' || split_part(sqlerrm, ':', 1); end $$;
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return coalesce(v, '<null>'); exception when others then return 'ERROR: ' || split_part(sqlerrm, ':', 1); end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- 시드: 01 대표 / 02 매니저 / 03 직원 / 04 타사 대표 / 05 고객
insert into auth.users (id,email) values
 ('8a999999-8a99-0000-0000-000000000001','owner@taxsum.test'),
 ('8a999999-8a99-0000-0000-000000000002','manager@taxsum.test'),
 ('8a999999-8a99-0000-0000-000000000003','staff@taxsum.test'),
 ('8a999999-8a99-0000-0000-000000000004','other@taxsum.test'),
 ('8a999999-8a99-0000-0000-000000000005','retailer@taxsum.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('8a999999-8a99-0000-0000-000000000001','wholesaler','대표','010',true,true),
 ('8a999999-8a99-0000-0000-000000000002','wholesaler','매니저','010',true,true),
 ('8a999999-8a99-0000-0000-000000000003','wholesaler','직원','010',true,true),
 ('8a999999-8a99-0000-0000-000000000004','wholesaler','타사대표','010',true,true),
 ('8a999999-8a99-0000-0000-000000000005','retailer','식당','010',false,false)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a8a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000001','집계축산','8a90000001','대표','active'),
 ('a8a99999-0000-0000-0000-000000000002','8a999999-8a99-0000-0000-000000000004','타사축산','8a90000002','타사','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('08a99999-0000-0000-0000-000000000001','a8a99999-0000-0000-0000-000000000001','집계축산','8a90000001'),
 ('08a99999-0000-0000-0000-000000000002','a8a99999-0000-0000-0000-000000000002','타사축산','8a90000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('08a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000001','owner'),
 ('08a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000002','manager'),
 ('08a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000003','staff'),
 ('08a99999-0000-0000-0000-000000000002','8a999999-8a99-0000-0000-000000000004','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d8a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000005','식당','사장','서울');

insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method,shipment_finalized_at) values
 ('e8a99999-0000-0000-0000-000000000001','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-T1',360000,'delivered','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000002','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-T2',50000,'delivered','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000004','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-T4',180000,'delivered','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000005','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-T5',99999,'delivered','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000006','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-T6',7000,'delivered','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000007','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-T7',8000,'delivered','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000008','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-T8',9000,'cancelled','서울','prepaid', now());
-- 발행이력(이번 달): I1 O1 최초 발행 완료 360,000 / I2 O1 정정(수정사유 1) 발행 완료 / I3 O2 진행 중 / I4 O2 실패 / I6 O5 취소
-- 지난 달: I5 O4 최초 발행 완료 180,000
-- 챙길 주문: I4(O2 실패)는 같은 주문에 더 나중 진행 중(I3)이 있어 숨는다 / O6 실패만 있음(I7) → 보인다 / O5(취소 이력뿐)·O7(이력 없음) → 계산서 없음 / O8은 취소 주문이라 제외
insert into public.tax_invoice_issuances (id,order_id,wholesaler_id,original_issuance_id,popbill_mgt_key,modify_code,status,issued_at,created_at) values
 ('f8a99999-0000-0000-0000-000000000001','e8a99999-0000-0000-0000-000000000001','a8a99999-0000-0000-0000-000000000001',null,'K1',null,'issued',now(),now()),
 ('f8a99999-0000-0000-0000-000000000002','e8a99999-0000-0000-0000-000000000001','a8a99999-0000-0000-0000-000000000001','f8a99999-0000-0000-0000-000000000001','K2',1,'issued',now(),now()),
 ('f8a99999-0000-0000-0000-000000000003','e8a99999-0000-0000-0000-000000000002','a8a99999-0000-0000-0000-000000000001',null,'K3',null,'pending',null,now() + interval '1 second'),
 ('f8a99999-0000-0000-0000-000000000004','e8a99999-0000-0000-0000-000000000002','a8a99999-0000-0000-0000-000000000001',null,'K4',null,'failed',null,now()),
 ('f8a99999-0000-0000-0000-000000000005','e8a99999-0000-0000-0000-000000000004','a8a99999-0000-0000-0000-000000000001',null,'K5',null,'issued',
    (date_trunc('month', now() at time zone 'Asia/Seoul') - interval '10 days') at time zone 'Asia/Seoul',
    (date_trunc('month', now() at time zone 'Asia/Seoul') - interval '10 days') at time zone 'Asia/Seoul'),
 ('f8a99999-0000-0000-0000-000000000006','e8a99999-0000-0000-0000-000000000005','a8a99999-0000-0000-0000-000000000001',null,'K6',null,'cancelled',now(),now());
insert into public.tax_invoice_issuances (id,order_id,wholesaler_id,popbill_mgt_key,status,error_message,created_at) values
 ('f8a99999-0000-0000-0000-000000000007','e8a99999-0000-0000-0000-000000000006','a8a99999-0000-0000-0000-000000000001','K7','failed','팝빌 응답 오류',now());

set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';

-- ========== 이번 달(기본 기간) ==========
insert into results (who,what,expected,result) values
 ('대표','이번 달 한 줄: 발행 1건 360,000 / 정정 1 / 진행 중 1 / 실패 2 (취소는 안 센다)','1|1|360000.00|1|1|2', pg_temp.val($q$select (select count(*) from public.get_tax_invoice_by_month())||'|'||issued_count||'|'||issued_amount||'|'||corrected_count||'|'||pending_count||'|'||failed_count from public.get_tax_invoice_by_month()$q$)),
 ('대표','거래처별: 이번 달 한 줄, 같은 숫자','1|360000.00|1|1|2|식당', pg_temp.val($q$select issued_count||'|'||issued_amount||'|'||corrected_count||'|'||pending_count||'|'||failed_count||'|'||retailer_name from public.get_tax_invoice_by_retailer()$q$));

-- ========== 챙겨야 할 주문 ==========
insert into results (who,what,expected,result) values
 ('대표','챙길 주문 4건(전체 건수)','4', pg_temp.val($q$select total_count::text from public.get_tax_invoice_todo() limit 1$q$)),
 ('대표','순서: 진행 중(O2) → 실패(O6) → 계산서 없음(O5, O7). O2의 오래된 실패·취소 주문·발행 완료 주문은 빠진다','pending:ORD-T2|failed:ORD-T6|missing:ORD-T5|missing:ORD-T7',
    pg_temp.val($q$select string_agg(kind||':'||order_number, '|' order by case kind when 'pending' then 1 when 'failed' then 2 else 3 end, order_number) from public.get_tax_invoice_todo()$q$)),
 ('대표','실패 줄에는 실패 사유가 붙는다','팝빌 응답 오류', pg_temp.val($q$select error_message from public.get_tax_invoice_todo() where kind='failed'$q$));

-- 같은 주문에 이후 발행이 성공하면 실패·계산서 없음 목록에서 사라진다
reset role;
insert into public.tax_invoice_issuances (order_id,wholesaler_id,popbill_mgt_key,status,issued_at,created_at) values
 ('e8a99999-0000-0000-0000-000000000006','a8a99999-0000-0000-0000-000000000001','K8','issued',now(),now() + interval '2 seconds'),
 ('e8a99999-0000-0000-0000-000000000007','a8a99999-0000-0000-0000-000000000001','K9','issued',now(),now());
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표','O6 재발행 성공·O7 발행 완료 → 챙길 주문은 진행 중 1 + 계산서 없음(O5)만 남는다','2', pg_temp.val($q$select count(*)::text from public.get_tax_invoice_todo()$q$)),
 ('대표','발행 금액이 그만큼 늘었다(360,000 + 7,000 + 8,000)','375000.00', pg_temp.val($q$select issued_amount::text from public.get_tax_invoice_by_month()$q$));

-- ========== 월별(지난 달 포함) ==========
insert into results (who,what,expected,result) values
 ('대표','최근 90일: 월 2줄, 최신 월이 위','2', pg_temp.val($q$select count(*)::text from public.get_tax_invoice_by_month(((now() at time zone 'Asia/Seoul')::date - 90), null)$q$)),
 ('대표','지난 달: 발행 1건 180,000 / 정정·진행 중·실패 0','1|180000.00|0|0|0', pg_temp.val($q$select issued_count||'|'||issued_amount||'|'||corrected_count||'|'||pending_count||'|'||failed_count from public.get_tax_invoice_by_month(((now() at time zone 'Asia/Seoul')::date - 90), null) order by month_start asc limit 1$q$)),
 ('대표','거래처별 최근 90일: 발행 4건 555,000 합산(정정 금액은 더하지 않는다)','4|555000.00', pg_temp.val($q$select issued_count||'|'||issued_amount from public.get_tax_invoice_by_retailer(((now() at time zone 'Asia/Seoul')::date - 90), null)$q$)),
 ('대표','발행이 없는 먼 과거 기간 → 0줄','0|0', pg_temp.val($q$select count(*)::text from public.get_tax_invoice_by_month('2000-01-01','2000-01-31')$q$)||'|'||pg_temp.val($q$select count(*)::text from public.get_tax_invoice_by_retailer('2000-01-01','2000-01-31')$q$));

-- ========== 기간 검증 ==========
insert into results (who,what,expected,result) values
 ('대표','시작이 끝보다 늦음 → 거부','DENIED: INVALID_RANGE', pg_temp.try($q$select * from public.get_tax_invoice_by_month('2026-02-01','2026-01-01')$q$)),
 ('대표','367일 넘는 기간 → 거부(월별·거래처별 모두)','DENIED: RANGE_TOO_LONG|DENIED: RANGE_TOO_LONG', pg_temp.try($q$select * from public.get_tax_invoice_by_month('2024-01-01','2025-06-01')$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_by_retailer('2024-01-01','2025-06-01')$q$));

-- ========== 권한 ==========
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('매니저','월별·거래처별·챙길 주문 → 허용(발행·조회 권한과 같다)','ALLOWED|ALLOWED|ALLOWED', pg_temp.try($q$select * from public.get_tax_invoice_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_by_retailer()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_todo()$q$));
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('직원','월별·거래처별·챙길 주문 → 거부','DENIED: NOT_MANAGER|DENIED: NOT_MANAGER|DENIED: NOT_MANAGER', pg_temp.try($q$select * from public.get_tax_invoice_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_by_retailer()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_todo()$q$));
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('타사 대표','자기 업체 숫자만 본다(집계축산 발행이력이 안 섞임, 0줄)','0|0|0', pg_temp.val($q$select count(*)::text from public.get_tax_invoice_by_month()$q$)||'|'||pg_temp.val($q$select count(*)::text from public.get_tax_invoice_by_retailer()$q$)||'|'||pg_temp.val($q$select count(*)::text from public.get_tax_invoice_todo()$q$));
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('고객','월별·거래처별 → 거부','DENIED: NOT_MANAGER|DENIED: NOT_MANAGER', pg_temp.try($q$select * from public.get_tax_invoice_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_by_retailer()$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','월별·거래처별·챙길 주문 → 거부','DENIED|DENIED|DENIED', pg_temp.try($q$select * from public.get_tax_invoice_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_by_retailer()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_todo()$q$));
reset role;

-- ========== 탭·메뉴 끄기 ==========
insert into public.wholesaler_features (wholesaler_id, feature_key, enabled) values
 ('a8a99999-0000-0000-0000-000000000001', 'accounting_tax_invoices', false);
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(탭 꺼짐)','월별·거래처별·챙길 주문 → 거부','DENIED: FEATURE_DISABLED|DENIED: FEATURE_DISABLED|DENIED: FEATURE_DISABLED', pg_temp.try($q$select * from public.get_tax_invoice_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_by_retailer()$q$)||'|'||pg_temp.try($q$select * from public.get_tax_invoice_todo()$q$)),
 ('대표(탭 꺼짐)','다른 탭(재고 조정·손실)은 그대로 열린다','ALLOWED', pg_temp.try($q$select * from public.list_stock_adjustments()$q$));
reset role;
delete from public.wholesaler_features where wholesaler_id='a8a99999-0000-0000-0000-000000000001' and feature_key='accounting_tax_invoices';
insert into public.wholesaler_features (wholesaler_id, feature_key, enabled) values
 ('a8a99999-0000-0000-0000-000000000001', 'accounting', false);
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(메뉴 꺼짐)','탭이 켜져 있어도 회계 관리 메뉴가 꺼지면 거부','DENIED: FEATURE_DISABLED', pg_temp.try($q$select * from public.get_tax_invoice_by_month()$q$));
reset role;
delete from public.wholesaler_features where wholesaler_id='a8a99999-0000-0000-0000-000000000001' and feature_key='accounting';
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(복구)','다시 켜면 숫자가 돌아온다','375000.00', pg_temp.val($q$select issued_amount::text from public.get_tax_invoice_by_month()$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','탭 키가 회계 관리 아래에 등록돼 있다','accounting', (select parent_key from public.platform_features where key='accounting_tax_invoices'));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected like 'DENIED|DENIED%' and result like 'DENIED%|DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected like 'DENIED|DENIED%' and result like 'DENIED%|DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected like 'DENIED|DENIED%' and result like 'DENIED%|DENIED%'))) as fail
  from results;
