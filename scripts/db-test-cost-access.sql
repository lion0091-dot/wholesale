-- 원가 접근 제한(209) — 대표 + 전표 담당 직원(최대 2명)만 원가를 보고 입력한다. 매니저·일반 직원·타사·고객·비로그인은 못 본다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-cost-access.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
    execute p_sql;
    return 'ALLOWED';
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text;
begin
    execute p_sql into v;
    return coalesce(v, '<null>');
exception when others then
    return 'ERROR: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table ids (key text primary key, payload jsonb);
grant all on ids to authenticated, anon, service_role;

create function pg_temp.rpc(p_key text, p_sql text) returns text language plpgsql as $$
declare j jsonb;
begin
    execute p_sql into j;
    insert into ids values (p_key, j) on conflict (key) do update set payload = excluded.payload;
    return 'ALLOWED';
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- ========== 시드 (접두어 96) ==========
-- 01 대표A / 02 매니저A / 03·04·05 직원A / 06 대표B / 07 고객
insert into auth.users (id,email) values
 ('96999999-0000-0000-0000-000000000001','owner-a@cost.test'),
 ('96999999-0000-0000-0000-000000000002','manager-a@cost.test'),
 ('96999999-0000-0000-0000-000000000003','staff1-a@cost.test'),
 ('96999999-0000-0000-0000-000000000004','staff2-a@cost.test'),
 ('96999999-0000-0000-0000-000000000005','staff3-a@cost.test'),
 ('96999999-0000-0000-0000-000000000006','owner-b@cost.test'),
 ('96999999-0000-0000-0000-000000000007','retailer@cost.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('96999999-0000-0000-0000-000000000001','wholesaler','A대표','010',true,true),
 ('96999999-0000-0000-0000-000000000002','wholesaler','A매니저','010',true,true),
 ('96999999-0000-0000-0000-000000000003','wholesaler','A직원1','010',true,true),
 ('96999999-0000-0000-0000-000000000004','wholesaler','A직원2','010',true,true),
 ('96999999-0000-0000-0000-000000000005','wholesaler','A직원3','010',true,true),
 ('96999999-0000-0000-0000-000000000006','wholesaler','B대표','010',true,true),
 ('96999999-0000-0000-0000-000000000007','retailer','식당','010',false,false)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a6999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000001','A축산','9690000001','A','active'),
 ('a6999999-0000-0000-0000-000000000002','96999999-0000-0000-0000-000000000006','B축산','9690000002','B','active');
-- A사는 "원가는 대표 + 전표 담당만"을 요청한 업체(옵트인). B사는 요청하지 않아 기본 정책(기존과 같음)이다.
update public.wholesalers set cost_access_policy = 'OWNER_AND_CLERK' where id = 'a6999999-0000-0000-0000-000000000001';
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('06999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','A축산','9690000001'),
 ('06999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000002','B축산','9690000002');
insert into public.organization_staff (id,organization_id,user_id,role) values
 ('56999999-0000-0000-0000-000000000001','06999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000001','owner'),
 ('56999999-0000-0000-0000-000000000002','06999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000002','manager'),
 ('56999999-0000-0000-0000-000000000003','06999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000003','staff'),
 ('56999999-0000-0000-0000-000000000004','06999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000004','staff'),
 ('56999999-0000-0000-0000-000000000005','06999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000005','staff'),
 ('56999999-0000-0000-0000-000000000006','06999999-0000-0000-0000-000000000002','96999999-0000-0000-0000-000000000006','owner');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('c6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0,true);
insert into public.suppliers (id,wholesaler_id,name) values
 ('d6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','대한유통');
insert into public.purchase_orders (id,wholesaler_id,supplier_id,supplier_name,ordered_on,status) values
 ('e6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','대한유통',current_date,'OPEN');
insert into public.purchase_order_lines (id,purchase_order_id,wholesaler_id,line_no,category,subcategory,grade,origin,quantity,unit,unit_price,product_id) values
 ('f6999999-0000-0000-0000-000000000001','e6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001',1,'소','등심','1++','국내산',40,'kg',52000,'c6999999-0000-0000-0000-000000000001');
insert into public.product_purchase_prices (wholesaler_id,product_id,unit_price,supplier_name) values
 ('a6999999-0000-0000-0000-000000000001','c6999999-0000-0000-0000-000000000001',38000,'대한유통');
-- 단가가 이미 있는 박스(마스터 이력은 postgres로 시드)
select public.upsert_master_livestock('009600000001','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-9,'○○도축장');
select public.upsert_master_livestock('009600000002','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-8,'○○도축장');
select public.upsert_master_livestock('009600000003','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-7,'○○도축장');
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight,purchase_unit_price) values
 ('b6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','009600000009',10,'kg','MANUAL','NORMAL','c6999999-0000-0000-0000-000000000001',10,40000);

-- ========== 5-A. 전표 담당 지정 (최대 2명, 일반 직원만, 대표만) ==========
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표','직원1을 전표 담당으로 지정 → 허용','ALLOWED', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000003', true)$q$)),
 ('A대표','직원2도 지정 → 허용(2명째)','ALLOWED', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000004', true)$q$)),
 ('A대표','직원3까지 3명째 지정 → 거부(회사당 2명)','DENIED: DOCUMENT_CLERK_LIMIT', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000005', true)$q$)),
 ('A대표','매니저를 전표 담당으로 지정 → 거부(일반 직원만)','DENIED: ONLY_STAFF_CAN_BE_CLERK', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000002', true)$q$)),
 ('A대표','테이블에 직접 UPDATE로 켜기 → 거부(RPC로만)','DENIED: FORBIDDEN', pg_temp.try($q$update public.organization_staff set is_document_clerk = true where id='56999999-0000-0000-0000-000000000005'$q$)),
 ('A대표','타사 직원을 지정 → 거부','DENIED: FORBIDDEN', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000006', true)$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','전표 담당 지정 시도 → 거부(대표만)','DENIED: FORBIDDEN', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000005', true)$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원1','자기 자신 해제·다른 직원 지정 시도 → 거부','DENIED: FORBIDDEN|DENIED: FORBIDDEN', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000003', false)$q$)||'|'||pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000005', true)$q$));

-- ========== 5-B. 원가를 볼 수 있는 사람 ==========
reset role;
insert into results (who,what,expected,result) values
 ('판정','대표=예, 전표담당 직원1·2=예, 일반 직원3=아니오, 매니저=아니오','true|true|true|false|false',
   (select string_agg(v, '|' order by ord) from (
      select 1 ord, (set_config('request.jwt.claim.sub','96999999-0000-0000-0000-000000000001',true) is not null and public.can_view_cost('a6999999-0000-0000-0000-000000000001'))::text v
      union all select 2, (set_config('request.jwt.claim.sub','96999999-0000-0000-0000-000000000003',true) is not null and public.can_view_cost('a6999999-0000-0000-0000-000000000001'))::text
      union all select 3, (set_config('request.jwt.claim.sub','96999999-0000-0000-0000-000000000004',true) is not null and public.can_view_cost('a6999999-0000-0000-0000-000000000001'))::text
      union all select 4, (set_config('request.jwt.claim.sub','96999999-0000-0000-0000-000000000005',true) is not null and public.can_view_cost('a6999999-0000-0000-0000-000000000001'))::text
      union all select 5, (set_config('request.jwt.claim.sub','96999999-0000-0000-0000-000000000002',true) is not null and public.can_view_cost('a6999999-0000-0000-0000-000000000001'))::text
   ) t)),
 ('판정','타사 대표·고객·무소속=아니오','false|false|false',
   (select string_agg(v, '|' order by ord) from (
      select 1 ord, (set_config('request.jwt.claim.sub','96999999-0000-0000-0000-000000000006',true) is not null and public.can_view_cost('a6999999-0000-0000-0000-000000000001'))::text v
      union all select 2, (set_config('request.jwt.claim.sub','96999999-0000-0000-0000-000000000007',true) is not null and public.can_view_cost('a6999999-0000-0000-0000-000000000001'))::text
      union all select 3, (set_config('request.jwt.claim.sub','',true) is not null and public.can_view_cost('a6999999-0000-0000-0000-000000000001'))::text
   ) t));

-- ========== 5-C. 원가 컬럼 직접 조회 차단 + 읽기 함수 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표','입고 박스 매입단가를 표에서 직접 조회 → 거부(함수로만)','DENIED', pg_temp.try($q$select purchase_unit_price from public.inbound_scans$q$)),
 ('A대표','입고 박스 select * → 거부(원가 컬럼 포함)','DENIED', pg_temp.try($q$select * from public.inbound_scans$q$)),
 ('A대표','입고 박스 다른 컬럼은 그대로 조회 → 허용','ALLOWED', pg_temp.try($q$select id, trace_no, weight, status, remaining_weight from public.inbound_scans$q$)),
 ('A대표','전표 줄 단가를 표에서 직접 조회 → 거부','DENIED', pg_temp.try($q$select unit_price from public.purchase_order_lines$q$)),
 ('A대표','전표 줄 다른 컬럼은 그대로 조회 → 허용','ALLOWED', pg_temp.try($q$select id, line_no, quantity from public.purchase_order_lines$q$)),
 ('A대표','get_scan_costs → 단가 40,000·금액 400,000','40000|400000', pg_temp.val($q$select unit_price::int||'|'||amount::int from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid])$q$)),
 ('A대표','get_po_line_prices → 52,000','52000', pg_temp.val($q$select (prices->>'1')::numeric::int::text from public.get_po_line_prices(array['e6999999-0000-0000-0000-000000000001'::uuid])$q$)),
 ('A대표','상품 기본 매입단가 조회 → 1건','1', pg_temp.val($q$select count(*)::text from public.product_purchase_prices$q$)),
 ('A대표','매입 정산 목록·합계 → 박스 1건','1|1', pg_temp.val($q$select (select count(*) from public.list_inbound_purchases())||'|'||(select box_count from public.summarize_inbound_purchases())$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원1(전표담당)','get_scan_costs·get_po_line_prices → 읽힘','40000|52000', pg_temp.val($q$select (select unit_price::int from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid]))||'|'||(select (prices->>'1')::numeric::int from public.get_po_line_prices(array['e6999999-0000-0000-0000-000000000001'::uuid]))$q$)),
 ('A직원1(전표담당)','상품 기본 매입단가·매입 정산 목록 → 읽힘','1|1', pg_temp.val($q$select (select count(*) from public.product_purchase_prices)||'|'||(select count(*) from public.list_inbound_purchases())$q$)),
 ('A직원1(전표담당)','단가 컬럼 직접 조회 → 거부','DENIED|DENIED', pg_temp.try($q$select purchase_unit_price from public.inbound_scans$q$)||'|'||pg_temp.try($q$select unit_price from public.purchase_order_lines$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A직원3(일반)','get_scan_costs·get_po_line_prices → 0건','0|0', pg_temp.val($q$select (select count(*) from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid]))||'|'||(select count(*) from public.get_po_line_prices(array['e6999999-0000-0000-0000-000000000001'::uuid]))$q$)),
 ('A직원3(일반)','상품 기본 매입단가 → 0건, 매입 정산 목록 → 0건','0|0', pg_temp.val($q$select (select count(*) from public.product_purchase_prices)||'|'||(select count(*) from public.list_inbound_purchases())$q$)),
 ('A직원3(일반)','매입 정산 합계 → 0건 집계','0', pg_temp.val($q$select box_count::text from public.summarize_inbound_purchases()$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','get_scan_costs·get_po_line_prices → 0건','0|0', pg_temp.val($q$select (select count(*) from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid]))||'|'||(select count(*) from public.get_po_line_prices(array['e6999999-0000-0000-0000-000000000001'::uuid]))$q$)),
 ('A매니저','상품 기본 매입단가·매입 정산 목록 → 0건','0|0', pg_temp.val($q$select (select count(*) from public.product_purchase_prices)||'|'||(select count(*) from public.list_inbound_purchases())$q$)),
 ('A매니저','매입단가 수정·기본단가 저장 → 거부','DENIED: FORBIDDEN|DENIED: FORBIDDEN', pg_temp.try($q$select public.update_inbound_purchase('b6999999-0000-0000-0000-000000000001', 41000)$q$)||'|'||pg_temp.try($q$select public.set_product_purchase_price('c6999999-0000-0000-0000-000000000001', 39000)$q$)),
 ('A매니저','원가 단가를 붙여 스캔 → 거부','DENIED: FORBIDDEN_PURCHASE_PRICE', pg_temp.try($q$select public.record_inbound_scan(p_trace_no => '009600000001', p_weight => 5.000, p_scan_type => 'BARCODE_SCAN', p_product_id => 'c6999999-0000-0000-0000-000000000001'::uuid, p_purchase_unit_price => 45000)$q$)),
 ('A매니저','보류함에서 "발주서 추가 생성" → 거부(전표는 대표·전표 담당만)','DENIED: FORBIDDEN', pg_temp.try($q$select public.create_purchase_order_from_unlisted_scan('b6999999-0000-0000-0000-000000000001'::uuid)$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('B대표','타사 대표: get_scan_costs·get_po_line_prices → 0건','0|0', pg_temp.val($q$select (select count(*) from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid]))||'|'||(select count(*) from public.get_po_line_prices(array['e6999999-0000-0000-0000-000000000001'::uuid]))$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000007';
insert into results (who,what,expected,result) values
 ('고객','get_scan_costs → 0건, 전표 기본 매입단가 → 0건','0|0', pg_temp.val($q$select (select count(*) from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid]))||'|'||(select count(*) from public.product_purchase_prices)$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','원가 읽기 함수·원가 컬럼 → 거부','DENIED|DENIED|DENIED', pg_temp.try($q$select * from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid])$q$)||'|'||pg_temp.try($q$select * from public.get_po_line_prices(array['e6999999-0000-0000-0000-000000000001'::uuid])$q$)||'|'||pg_temp.try($q$select purchase_unit_price from public.inbound_scans$q$));

-- ========== 5-D. 현장 스캔 응답으로 원가가 새지 않는다 (상품 기본단가 자동 적용 경로) ==========
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A직원3(일반)','현장 스캔 → 허용, 응답에 매입단가·금액 없음','ALLOWED|<null>|<null>', pg_temp.rpc('S1', $q$select public.record_inbound_scan('009600000001', 5.000, 'BARCODE_SCAN', 'c6999999-0000-0000-0000-000000000001')$q$)||'|'||pg_temp.val($q$select payload->>'purchase_unit_price' from ids where key='S1'$q$)||'|'||pg_temp.val($q$select payload->>'purchase_amount' from ids where key='S1'$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원1(전표담당)','현장 스캔 → 응답에 기본 매입단가 38,000이 보임','ALLOWED|38000', pg_temp.rpc('S2', $q$select public.record_inbound_scan('009600000002', 5.000, 'BARCODE_SCAN', 'c6999999-0000-0000-0000-000000000001')$q$)||'|'||pg_temp.val($q$select (payload->>'purchase_unit_price')::numeric::int::text from ids where key='S2'$q$));
reset role;
insert into results (who,what,expected,result) values
 ('시스템','  └ 직원3이 찍은 박스(009600000001)에 기본단가 38,000이 저장됨','38000', (select purchase_unit_price::int::text from public.inbound_scans where trace_no='009600000001'));

-- ========== 5-E. 전표 입력·거래처 등록 권한 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원1(전표담당)','전표 만들기 → 허용','ALLOWED', pg_temp.try($q$insert into public.purchase_orders (id,wholesaler_id,supplier_id,supplier_name,ordered_on) values ('e6999999-0000-0000-0000-000000000011','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','대한유통',current_date)$q$)),
 ('A직원1(전표담당)','전표 줄(단가 포함) 넣기 → 허용','ALLOWED', pg_temp.try($q$insert into public.purchase_order_lines (purchase_order_id,wholesaler_id,line_no,category,subcategory,grade,origin,quantity,unit,unit_price) values ('e6999999-0000-0000-0000-000000000011','a6999999-0000-0000-0000-000000000001',1,'소','등심','1+','국내산',10,'kg',50000)$q$)),
 ('A직원1(전표담당)','거래처 등록 → 허용','ALLOWED', pg_temp.try($q$insert into public.suppliers (wholesaler_id,name) values ('a6999999-0000-0000-0000-000000000001','신규유통')$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A직원3(일반)','전표 만들기·거래처 등록 → 거부','DENIED|DENIED', pg_temp.try($q$insert into public.purchase_orders (wholesaler_id,supplier_id,supplier_name,ordered_on) values ('a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','대한유통',current_date)$q$)||'|'||pg_temp.try($q$insert into public.suppliers (wholesaler_id,name) values ('a6999999-0000-0000-0000-000000000001','몰래유통')$q$)),
 ('A직원3(일반)','전표 진행 상황(헤더)은 읽힘','1', pg_temp.val($q$select count(*)::text from public.purchase_orders where id='e6999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','전표 만들기 → 거부(매니저는 전표에서 빠진다)','DENIED', pg_temp.try($q$insert into public.purchase_orders (wholesaler_id,supplier_id,supplier_name,ordered_on) values ('a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000001','대한유통',current_date)$q$)),
 ('A매니저','거래처 등록은 그대로 허용(원가 정보가 아님)','ALLOWED', pg_temp.try($q$insert into public.suppliers (wholesaler_id,name) values ('a6999999-0000-0000-0000-000000000001','매니저유통')$q$));

-- ========== 5-F. 전표 담당 해제·승격 ==========
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표','직원1 해제 → 허용','ALLOWED', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000003', false)$q$)),
 ('A대표','해제 뒤 직원3을 지정 → 허용(2명 한도에 자리 생김)','ALLOWED', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000005', true)$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원1(해제됨)','해제되면 원가 읽기 함수가 0건','0|0', pg_temp.val($q$select (select count(*) from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid]))||'|'||(select count(*) from public.product_purchase_prices)$q$));
reset role;
update public.organization_staff set role = 'manager' where id = '56999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('시스템','전표 담당(직원2)이 매니저로 승격되면 표시가 자동으로 내려감','false', (select is_document_clerk::text from public.organization_staff where id='56999999-0000-0000-0000-000000000004'));

-- ========== 5-H. 업체별 정책 (기본값을 바꾸는 건 플랫폼 운영자만) ==========
reset role;
update public.wholesalers set cost_access_policy = 'OWNER_MANAGER_AND_CLERK' where id = 'a6999999-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('A매니저(정책: 매니저 포함)','업체 정책을 "대표+매니저+전표 담당"으로 바꾸면 매니저도 원가를 읽는다','1|1', pg_temp.val($q$select (select count(*) from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid]))||'|'||(select count(*) from public.product_purchase_prices)$q$)),
 ('A매니저(정책: 매니저 포함)','매니저가 매입단가를 고칠 수 있다','ALLOWED', pg_temp.try($q$select public.update_inbound_purchase('b6999999-0000-0000-0000-000000000001', 41000)$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000005';
reset role;
update public.wholesalers set cost_access_policy = 'OWNER_ONLY' where id = 'a6999999-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A직원3(전표담당, 정책: 대표만)','업체 정책이 "대표만"이면 전표 담당도 원가를 못 읽는다','0|0', pg_temp.val($q$select (select count(*) from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid]))||'|'||(select count(*) from public.product_purchase_prices)$q$));
set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표(정책: 대표만)','대표는 어느 정책에서나 읽는다','1', pg_temp.val($q$select count(*)::text from public.get_scan_costs(array['b6999999-0000-0000-0000-000000000001'::uuid])$q$)),
 ('A대표','대표가 스스로 원가 열람 정책·전표 담당 인원을 바꾸기 → 거부(플랫폼 전용)','DENIED: PLATFORM_ONLY_COLUMN|DENIED: PLATFORM_ONLY_COLUMN', pg_temp.try($q$update public.wholesalers set cost_access_policy = 'OWNER_MANAGER_AND_CLERK' where id='a6999999-0000-0000-0000-000000000001'$q$)||'|'||pg_temp.try($q$update public.wholesalers set document_clerk_limit = 10 where id='a6999999-0000-0000-0000-000000000001'$q$));
reset role;
update public.wholesalers set cost_access_policy = 'OWNER_AND_CLERK', document_clerk_limit = 1 where id = 'a6999999-0000-0000-0000-000000000001';
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '96999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표(전표 담당 최대 1명)','업체 설정으로 최대 인원을 1명으로 줄이면 2번째 지정이 거부된다(이미 직원3이 담당)','DENIED: DOCUMENT_CLERK_LIMIT', pg_temp.try($q$select public.set_document_clerk('56999999-0000-0000-0000-000000000003', true)$q$));
reset role;
update public.wholesalers set document_clerk_limit = 2 where id = 'a6999999-0000-0000-0000-000000000001';

insert into results (who,what,expected,result) values
 ('시스템','요청하지 않은 업체(B)는 기존과 같은 기본 정책(대표+매니저+전표 담당)이다 — 원하는 업체만 좁힌다','OWNER_MANAGER_AND_CLERK|2',
   (select cost_access_policy||'|'||document_clerk_limit from public.wholesalers where id='a6999999-0000-0000-0000-000000000002'));

-- ========== 5-G. 컬럼 가드: 원가 컬럼만 막히고 새 컬럼이 조용히 막히지 않는다 ==========
insert into results (who,what,expected,result) values
 ('가드','inbound_scans: 원가 두 컬럼 외 모든 컬럼에 authenticated SELECT 권한이 있다(새 컬럼 누락 감지)','0',
   (select count(*)::text from information_schema.columns c where c.table_schema='public' and c.table_name='inbound_scans'
      and c.column_name not in ('purchase_unit_price','purchase_amount')
      and not has_column_privilege('authenticated','public.inbound_scans',c.column_name,'select'))),
 ('가드','purchase_order_lines: unit_price 외 모든 컬럼에 authenticated SELECT 권한이 있다','0',
   (select count(*)::text from information_schema.columns c where c.table_schema='public' and c.table_name='purchase_order_lines'
      and c.column_name <> 'unit_price'
      and not has_column_privilege('authenticated','public.purchase_order_lines',c.column_name,'select'))),
 ('가드','원가 컬럼은 authenticated·anon 모두 SELECT 불가','false|false|false|false|false|false',
   has_column_privilege('authenticated','public.inbound_scans','purchase_unit_price','select')::text||'|'||
   has_column_privilege('authenticated','public.inbound_scans','purchase_amount','select')::text||'|'||
   has_column_privilege('authenticated','public.purchase_order_lines','unit_price','select')::text||'|'||
   has_column_privilege('anon','public.inbound_scans','purchase_unit_price','select')::text||'|'||
   has_column_privilege('anon','public.inbound_scans','purchase_amount','select')::text||'|'||
   has_column_privilege('anon','public.purchase_order_lines','unit_price','select')::text);

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%')
                 or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%')
                 or (expected = 'DENIED|DENIED|DENIED' and result like 'DENIED%|DENIED%|DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results where result is not null order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')
                 or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%')
                 or (expected = 'DENIED|DENIED|DENIED' and result like 'DENIED%|DENIED%|DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%')
                 or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%')
                 or (expected = 'DENIED|DENIED|DENIED' and result like 'DENIED%|DENIED%|DENIED%'))) as fail
  from results where result is not null;
