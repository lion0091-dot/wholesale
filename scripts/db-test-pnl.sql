-- 회계 관리 > 손익 관리 탭(219) — 매출총이익 기준 조회: 출고 확정 주문만, 취소 제외, 원가 미입력·손실 금액 미상 분리, 월별·상품별, 대표 전용, 탭·메뉴 끄기.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-pnl.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ALLOWED'; exception when others then return 'DENIED: ' || split_part(sqlerrm, ':', 1); end $$;
create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return coalesce(v, '<null>'); exception when others then return 'ERROR: ' || split_part(sqlerrm, ':', 1); end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- 시드: 01 대표 / 02 매니저 / 03 직원 / 04 타사 대표 / 05 고객
insert into auth.users (id,email) values
 ('8a999999-8a99-0000-0000-000000000001','owner@pnl.test'),
 ('8a999999-8a99-0000-0000-000000000002','manager@pnl.test'),
 ('8a999999-8a99-0000-0000-000000000003','staff@pnl.test'),
 ('8a999999-8a99-0000-0000-000000000004','other@pnl.test'),
 ('8a999999-8a99-0000-0000-000000000005','retailer@pnl.test');
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
 ('a8a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000001','손익축산','8a90000001','대표','active'),
 ('a8a99999-0000-0000-0000-000000000002','8a999999-8a99-0000-0000-000000000004','타사축산','8a90000002','타사','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('08a99999-0000-0000-0000-000000000001','a8a99999-0000-0000-0000-000000000001','손익축산','8a90000001'),
 ('08a99999-0000-0000-0000-000000000002','a8a99999-0000-0000-0000-000000000002','타사축산','8a90000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('08a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000001','owner'),
 ('08a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000002','manager'),
 ('08a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000003','staff'),
 ('08a99999-0000-0000-0000-000000000002','8a999999-8a99-0000-0000-000000000004','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d8a99999-0000-0000-0000-000000000001','8a999999-8a99-0000-0000-000000000005','식당','사장','서울');
-- 상품 A(kg, 재고 5 = 박스1 3 + 박스2 2), 상품 B(개, 재고 20, 박스 없음), 타사 상품
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('c8a99999-0000-0000-0000-000000000001','a8a99999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',60000,'kg',5,true),
 ('c8a99999-0000-0000-0000-000000000002','a8a99999-0000-0000-0000-000000000001','계란','닭','계란','국내산',null,5000,'개',20,true),
 ('c8a99999-0000-0000-0000-000000000003','a8a99999-0000-0000-0000-000000000002','타사 등심','소','등심','국내산','1++',60000,'kg',10,true);
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight,purchase_unit_price) values
 ('b8a99999-0000-0000-0000-000000000001','a8a99999-0000-0000-0000-000000000001','08a900000001',10,'kg','MANUAL','NORMAL','c8a99999-0000-0000-0000-000000000001',3,40000),
 ('b8a99999-0000-0000-0000-000000000002','a8a99999-0000-0000-0000-000000000001','08a900000002',4,'kg','MANUAL','NORMAL','c8a99999-0000-0000-0000-000000000001',2,null),
 ('b8a99999-0000-0000-0000-000000000003','a8a99999-0000-0000-0000-000000000002','08a900000003',10,'kg','MANUAL','NORMAL','c8a99999-0000-0000-0000-000000000003',10,30000);
-- 주문(이번 달): O1 출고확정 A 6kg x 60,000 / O2 출고확정 B 10개 x 5,000 / O3 취소 A 1kg / O5 출고 전(확정만)
-- 지난 달: O4 출고확정 A 3kg x 60,000
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method,shipment_finalized_at) values
 ('e8a99999-0000-0000-0000-000000000001','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-P1',360000,'delivered','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000002','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-P2',50000,'delivered','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000003','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-P3',60000,'cancelled','서울','prepaid', now()),
 ('e8a99999-0000-0000-0000-000000000004','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-P4',180000,'delivered','서울','prepaid',
    (date_trunc('month', now() at time zone 'Asia/Seoul') - interval '10 days') at time zone 'Asia/Seoul'),
 ('e8a99999-0000-0000-0000-000000000005','a8a99999-0000-0000-0000-000000000001','d8a99999-0000-0000-0000-000000000001','ORD-P5',99999,'confirmed','서울','prepaid', null);
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,shipped_quantity,subtotal_amount) values
 ('e8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000001','한우 등심',60000,6,6,360000),
 ('e8a99999-0000-0000-0000-000000000002','c8a99999-0000-0000-0000-000000000002','계란',5000,10,10,50000),
 ('e8a99999-0000-0000-0000-000000000003','c8a99999-0000-0000-0000-000000000001','한우 등심',60000,1,1,60000),
 ('e8a99999-0000-0000-0000-000000000004','c8a99999-0000-0000-0000-000000000001','한우 등심',60000,3,3,180000),
 ('e8a99999-0000-0000-0000-000000000005','c8a99999-0000-0000-0000-000000000001','한우 등심',60000,2,null,99999);
-- 장부: 박스 입고 + 주문 출고(O1: 박스1 4kg·박스2 2kg, O2: 박스 없는 재고 10개, O3: 박스1 1kg 나갔다 원복, O4: 박스1 3kg)
insert into public.stock_ledger (wholesaler_id,product_id,inbound_scan_id,qty_delta,event_type,source_type,source_id) values
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000001','b8a99999-0000-0000-0000-000000000001',10,'INBOUND','inbound_scan','b8a99999-0000-0000-0000-000000000001'),
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000001','b8a99999-0000-0000-0000-000000000002',4,'INBOUND','inbound_scan','b8a99999-0000-0000-0000-000000000002'),
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000001','b8a99999-0000-0000-0000-000000000001',-4,'ORDER_OUT','order','e8a99999-0000-0000-0000-000000000001'),
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000001','b8a99999-0000-0000-0000-000000000002',-2,'ORDER_OUT','order','e8a99999-0000-0000-0000-000000000001'),
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000002',null,30,'OPENING_BALANCE','product',null),
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000002',null,-10,'ORDER_OUT','order','e8a99999-0000-0000-0000-000000000002'),
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000001','b8a99999-0000-0000-0000-000000000001',-1,'ORDER_OUT','order','e8a99999-0000-0000-0000-000000000003'),
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000001','b8a99999-0000-0000-0000-000000000001',1,'ORDER_RESTORE','order','e8a99999-0000-0000-0000-000000000003'),
 ('a8a99999-0000-0000-0000-000000000001','c8a99999-0000-0000-0000-000000000001','b8a99999-0000-0000-0000-000000000001',-3,'ORDER_OUT','order','e8a99999-0000-0000-0000-000000000004');

set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';

-- 손실: 박스1 1kg 폐기(40,000원) + 상품 B 개수 조정으로 2개 손실(금액 미상)
select public.dispose_box('b8a99999-0000-0000-0000-000000000001', 1, 'EXPIRED', null, 3);
select public.adjust_product_stock('c8a99999-0000-0000-0000-000000000002', 18, 'DAMAGE');

-- ========== 이번 달(기본 기간) ==========
insert into results (who,what,expected,result) values
 ('대표','이번 달 한 줄: 주문 2건(출고 확정만, 취소·출고 전 제외) / 매출 410,000 / 원가 160,000','1|2|410000.00|160000', pg_temp.val($q$select (select count(*) from public.get_pnl_by_month())||'|'||order_count||'|'||sales_amount||'|'||cost_amount from public.get_pnl_by_month()$q$)),
 ('대표','원가 미입력 상품 2개(박스 단가 없음 A, 박스 없는 재고 B) / 손실 금액 40,000 / 금액 미상 손실 1건','2|40000|1', pg_temp.val($q$select unpriced_items||'|'||loss_amount||'|'||loss_unpriced_events from public.get_pnl_by_month()$q$)),
 ('대표','상품별 A: 출고 6 / 매출 360,000 / 원가 160,000 / 원가 미입력 2 / 손실 1kg·40,000','6.000|360000.00|160000|2.000|1.000|40000|0', pg_temp.val($q$select shipped_qty||'|'||sales_amount||'|'||cost_amount||'|'||unpriced_qty||'|'||loss_qty||'|'||loss_amount||'|'||loss_unpriced_qty from public.get_pnl_by_product() where product_name='한우 등심'$q$)),
 ('대표','상품별 B(개): 출고 10 / 매출 50,000 / 원가 0이 아니라 미입력 10 / 손실 2개 금액 미상','10.000|50000.00|0|10.000|2.000|0|2.000', pg_temp.val($q$select shipped_qty||'|'||sales_amount||'|'||cost_amount||'|'||unpriced_qty||'|'||loss_qty||'|'||loss_amount||'|'||loss_unpriced_qty from public.get_pnl_by_product() where product_name='계란'$q$)),
 ('대표','상품별: 매출 큰 순서(한우 등심이 먼저)','한우 등심', pg_temp.val($q$select product_name from public.get_pnl_by_product() limit 1$q$));

-- ========== 월별(지난 달 포함) ==========
insert into results (who,what,expected,result) values
 ('대표','최근 90일: 월 2줄(이번 달·지난 달), 최신 월이 위','2', pg_temp.val($q$select count(*)::text from public.get_pnl_by_month(((now() at time zone 'Asia/Seoul')::date - 90), null)$q$)),
 ('대표','지난 달: 주문 1건 / 매출 180,000 / 원가 120,000 / 원가 미입력 0 / 손실 0','1|180000.00|120000|0|0|0', pg_temp.val($q$select order_count||'|'||sales_amount||'|'||cost_amount||'|'||unpriced_items||'|'||loss_amount||'|'||loss_unpriced_events from public.get_pnl_by_month(((now() at time zone 'Asia/Seoul')::date - 90), null) order by month_start asc limit 1$q$)),
 ('대표','지난 달만 조회 → 이번 달 숫자가 섞이지 않는다(주문 1건)','1', pg_temp.val($q$select sum(order_count)::text from public.get_pnl_by_month(((now() at time zone 'Asia/Seoul')::date - 90), (date_trunc('month', now() at time zone 'Asia/Seoul')::date - 1))$q$)),
 ('대표','출고 확정이 없는 먼 과거 기간 → 0줄','0', pg_temp.val($q$select count(*)::text from public.get_pnl_by_month('2000-01-01','2000-01-31')$q$));

-- ========== 기간 검증 ==========
insert into results (who,what,expected,result) values
 ('대표','시작이 끝보다 늦음 → 거부','DENIED: INVALID_RANGE', pg_temp.try($q$select * from public.get_pnl_by_month('2026-02-01','2026-01-01')$q$)),
 ('대표','367일 넘는 기간 → 거부(월별·상품별 모두)','DENIED: RANGE_TOO_LONG|DENIED: RANGE_TOO_LONG', pg_temp.try($q$select * from public.get_pnl_by_month('2024-01-01','2025-06-01')$q$)||'|'||pg_temp.try($q$select * from public.get_pnl_by_product('2024-01-01','2025-06-01')$q$));

-- ========== 권한 ==========
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('매니저','월별·상품별 → 거부(대표 전용)','DENIED: NOT_OWNER|DENIED: NOT_OWNER', pg_temp.try($q$select * from public.get_pnl_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_pnl_by_product()$q$));
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('직원','월별·상품별 → 거부','DENIED: NOT_OWNER|DENIED: NOT_OWNER', pg_temp.try($q$select * from public.get_pnl_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_pnl_by_product()$q$));
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('타사 대표','자기 업체 숫자만 본다(손익축산 주문·상품이 안 섞임, 0줄)','0|0', pg_temp.val($q$select count(*)::text from public.get_pnl_by_month()$q$)||'|'||pg_temp.val($q$select count(*)::text from public.get_pnl_by_product()$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','월별·상품별 → 거부','DENIED|DENIED', pg_temp.try($q$select * from public.get_pnl_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_pnl_by_product()$q$));

-- ========== 탭·메뉴 끄기 ==========
reset role;
insert into public.wholesaler_features (wholesaler_id, feature_key, enabled) values
 ('a8a99999-0000-0000-0000-000000000001', 'accounting_pnl', false);
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(탭 꺼짐)','월별·상품별 → 거부','DENIED: FEATURE_DISABLED|DENIED: FEATURE_DISABLED', pg_temp.try($q$select * from public.get_pnl_by_month()$q$)||'|'||pg_temp.try($q$select * from public.get_pnl_by_product()$q$)),
 ('대표(탭 꺼짐)','다른 탭(재고 조정·손실)은 그대로 열린다','ALLOWED', pg_temp.try($q$select * from public.list_stock_adjustments()$q$));
reset role;
delete from public.wholesaler_features where wholesaler_id='a8a99999-0000-0000-0000-000000000001' and feature_key='accounting_pnl';
insert into public.wholesaler_features (wholesaler_id, feature_key, enabled) values
 ('a8a99999-0000-0000-0000-000000000001', 'accounting', false);
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(메뉴 꺼짐)','탭이 켜져 있어도 회계 관리 메뉴가 꺼지면 거부','DENIED: FEATURE_DISABLED', pg_temp.try($q$select * from public.get_pnl_by_month()$q$));
reset role;
delete from public.wholesaler_features where wholesaler_id='a8a99999-0000-0000-0000-000000000001' and feature_key='accounting';
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '8a999999-8a99-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('대표(복구)','다시 켜면 숫자가 돌아온다','410000.00', pg_temp.val($q$select sales_amount::text from public.get_pnl_by_month()$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','탭 키가 회계 관리 아래에 등록돼 있다','accounting', (select parent_key from public.platform_features where key='accounting_pnl'));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%'))) as fail
  from results;
