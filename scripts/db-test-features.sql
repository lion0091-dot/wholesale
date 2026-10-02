-- 업체별 기능 켜기/끄기(210) + 첫 기능 "원가 관리" — 운영자가 켜고 끄고, 대표가 업체 안에서 누가 볼지 정한다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-features.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
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

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- ========== 시드 (접두어 97) ==========
-- 01 대표A / 02 매니저A / 03 직원A / 04 대표B / 05 슈퍼관리자 / 06 고객
insert into auth.users (id,email) values
 ('97999999-0000-0000-0000-000000000001','owner-a@feat.test'),
 ('97999999-0000-0000-0000-000000000002','manager-a@feat.test'),
 ('97999999-0000-0000-0000-000000000003','staff-a@feat.test'),
 ('97999999-0000-0000-0000-000000000004','owner-b@feat.test'),
 ('97999999-0000-0000-0000-000000000005','admin@feat.test'),
 ('97999999-0000-0000-0000-000000000006','retailer@feat.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('97999999-0000-0000-0000-000000000001','wholesaler','A대표','010',true,true),
 ('97999999-0000-0000-0000-000000000002','wholesaler','A매니저','010',true,true),
 ('97999999-0000-0000-0000-000000000003','wholesaler','A직원','010',true,true),
 ('97999999-0000-0000-0000-000000000004','wholesaler','B대표','010',true,true),
 ('97999999-0000-0000-0000-000000000005','super_admin','운영자','010',false,false),
 ('97999999-0000-0000-0000-000000000006','retailer','식당','010',false,false)
 on conflict (id) do update set role=excluded.role, name=excluded.name, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a7999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000001','A축산','9790000001','A','active'),
 ('a7999999-0000-0000-0000-000000000002','97999999-0000-0000-0000-000000000004','B축산','9790000002','B','active');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('07999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','A축산','9790000001'),
 ('07999999-0000-0000-0000-000000000002','a7999999-0000-0000-0000-000000000002','B축산','9790000002');
insert into public.organization_staff (id,organization_id,user_id,role) values
 ('57999999-0000-0000-0000-000000000001','07999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000001','owner'),
 ('57999999-0000-0000-0000-000000000002','07999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000002','manager'),
 ('57999999-0000-0000-0000-000000000003','07999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000003','staff'),
 ('57999999-0000-0000-0000-000000000004','07999999-0000-0000-0000-000000000002','97999999-0000-0000-0000-000000000004','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d7999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000006','식당','사장','서울');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('c7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',20,true);
-- 박스: 40일 된 10kg(40,000원/kg) / 5일 된 5kg(50,000원) / 단가 없는 3kg / 취소된 7kg / 다 나간 0kg  → 남은 3박스 18kg, 박스 없는 재고 2kg(재고 20 - 18)
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight,purchase_unit_price,created_at) values
 ('b7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','079700000001',10,'kg','MANUAL','NORMAL','c7999999-0000-0000-0000-000000000001',10,40000, now() - interval '40 days'),
 ('b7999999-0000-0000-0000-000000000002','a7999999-0000-0000-0000-000000000001','079700000002',5,'kg','MANUAL','NORMAL','c7999999-0000-0000-0000-000000000001',5,50000, now() - interval '5 days'),
 ('b7999999-0000-0000-0000-000000000003','a7999999-0000-0000-0000-000000000001','079700000003',3,'kg','MANUAL','NORMAL','c7999999-0000-0000-0000-000000000001',3,null, now() - interval '1 day'),
 ('b7999999-0000-0000-0000-000000000004','a7999999-0000-0000-0000-000000000001','079700000004',7,'kg','MANUAL','VOIDED','c7999999-0000-0000-0000-000000000001',7,1, now() - interval '60 days'),
 ('b7999999-0000-0000-0000-000000000005','a7999999-0000-0000-0000-000000000001','079700000005',4,'kg','MANUAL','NORMAL','c7999999-0000-0000-0000-000000000001',0,1, now() - interval '70 days');
-- 마진 함수 접근 검사용 주문(내용은 중요하지 않다)
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method) values
 ('e7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','ORD-F1',100000,'confirmed','서울','prepaid');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e7999999-0000-0000-0000-000000000001','c7999999-0000-0000-0000-000000000001','한우 등심',68000,1,68000);

-- ========== 7-A. 기본값과 운영자만 켜고 끄기 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표','원가 관리는 메뉴판 기본값(켜짐)을 따라 켜져 있다','true', pg_temp.val($q$select public.feature_enabled('a7999999-0000-0000-0000-000000000001','cost_management')::text$q$)),
 ('A대표','메뉴판에 없는 기능은 꺼짐','false', pg_temp.val($q$select public.feature_enabled('a7999999-0000-0000-0000-000000000001','nothing_here')::text$q$)),
 ('A대표','업체 대표가 스스로 기능을 끄기 → 거부(운영자 전용)','DENIED: FORBIDDEN', pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',false)$q$)),
 ('A대표','기능 표에 직접 쓰기(켜짐 표·메뉴판) → 거부','DENIED|DENIED', pg_temp.try($q$insert into public.wholesaler_features (wholesaler_id,feature_key,enabled) values ('a7999999-0000-0000-0000-000000000001','cost_management',false)$q$)||'|'||pg_temp.try($q$update public.platform_features set default_enabled=false$q$)),
 ('A대표','운영자 전용 전체 목록 조회 → 거부','DENIED: FORBIDDEN', pg_temp.try($q$select * from public.admin_list_wholesaler_features()$q$)),
 ('A대표','자기 업체의 켜진 기능 목록에 원가 관리가 있다','cost_management', pg_temp.val($q$select string_agg(feature_key, ',') from public.current_wholesaler_features()$q$)),
 ('A대표','자기 업체 켜짐 표를 읽을 수는 있다(쓰기만 막힘)','ALLOWED', pg_temp.try($q$select * from public.wholesaler_features$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','매니저가 기능 켜고 끄기 → 거부','DENIED: FORBIDDEN', pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',false)$q$));
set role anon; set request.jwt.claim.sub = ''; set request.jwt.claim.role = 'anon';
insert into results (who,what,expected,result) values
 ('비로그인','기능 판정·설정 함수 호출 → 거부','DENIED|DENIED|DENIED', pg_temp.try($q$select public.feature_enabled('a7999999-0000-0000-0000-000000000001','cost_management')$q$)||'|'||pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',false)$q$)||'|'||pg_temp.try($q$select * from public.platform_features$q$));

set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('운영자','없는 기능 → 거부 / 없는 업체 → 거부 / 설정이 객체가 아니면 → 거부','DENIED: UNKNOWN_FEATURE|DENIED: WHOLESALER_NOT_FOUND|DENIED: INVALID_CONFIG',
   pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','nothing_here',true)$q$)||'|'||
   pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-0000000000ff','cost_management',true)$q$)||'|'||
   pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',true,'[1]'::jsonb)$q$)),
 ('운영자','A업체 세부 설정(오래된 재고 45일)과 함께 켜기 → 허용','ALLOWED', pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',true,'{"aging_days":45}'::jsonb)$q$)),
 ('운영자','설정을 비워 두고(null) 다시 켜기 → 기존 세부 설정이 유지된다','45', pg_temp.val($q$select (select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',true)) is null as x$q$)||'' ),
 ('운영자','전체 목록: 모든 업체 × 기능 1개(업체 수만큼), A만 직접 정한 값','true|1', pg_temp.val($q$select (count(*) = (select count(*) from public.wholesalers))::text||'|'||count(*) filter (where is_override and wholesaler_id in ('a7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000002')) from public.admin_list_wholesaler_features()$q$)),
 ('운영자','운영자는 업체 안의 원가 관리 기능을 쓰지 못한다(마진 → 거부)','DENIED: NOT_OWNER', pg_temp.try($q$select * from public.get_order_margin('e7999999-0000-0000-0000-000000000001')$q$));

-- 위 3번째 행의 expected는 "45"인데 val이 null 비교 결과를 돌려주므로, 세부 설정 유지 여부는 아래에서 직접 확인한다.
delete from results where what like '설정을 비워 두고%';
reset role;
insert into results (who,what,expected,result) values
 ('시스템','세부 설정을 비워 두고 다시 켜도 기존 설정(45일)이 유지된다','45', (select config->>'aging_days' from public.wholesaler_features where wholesaler_id='a7999999-0000-0000-0000-000000000001' and feature_key='cost_management'));

-- ========== 7-B. 대표가 업체 안에서 누가 볼지 정한다 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표','허용 전: 매니저는 원가 관리를 못 쓴다(대표 화면에서 확인)','true|false|false', pg_temp.val($q$select public.can_use_feature('a7999999-0000-0000-0000-000000000001','cost_management')::text$q$)||'|false|false'),
 ('A대표','매니저에게 원가 관리 보기 허용 → 허용','ALLOWED', pg_temp.try($q$select public.set_feature_viewer('cost_management','97999999-0000-0000-0000-000000000002',true)$q$)),
 ('A대표','타사 대표를 허용 시도 → 거부(우리 업체 사람만)','DENIED: NOT_A_MEMBER', pg_temp.try($q$select public.set_feature_viewer('cost_management','97999999-0000-0000-0000-000000000004',true)$q$)),
 ('A대표','대표 본인을 허용 시도 → 거부(대표는 허용이 필요 없다)','DENIED: NOT_A_MEMBER', pg_temp.try($q$select public.set_feature_viewer('cost_management','97999999-0000-0000-0000-000000000001',true)$q$)),
 ('A대표','허용 목록 = 매니저 1명','97999999-0000-0000-0000-000000000002', pg_temp.val($q$select string_agg(user_id::text, ',') from public.list_feature_viewers('cost_management')$q$)),
 ('A대표','없는 기능 키로 허용 → 거부','DENIED: FEATURE_DISABLED', pg_temp.try($q$select public.set_feature_viewer('nothing_here','97999999-0000-0000-0000-000000000002',true)$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저(허용됨)','허용된 매니저는 원가 관리를 쓸 수 있다','true', pg_temp.val($q$select public.can_use_feature('a7999999-0000-0000-0000-000000000001','cost_management')::text$q$)),
 ('A매니저(허용됨)','내가 쓸 수 있는 기능 목록에 원가 관리가 있다','cost_management', pg_temp.val($q$select string_agg(feature_key, ',') from public.my_usable_features()$q$)),
 ('A매니저(허용됨)','허용 목록을 직접 조작 → 거부 / 목록 조회 → 0건','DENIED: FORBIDDEN|0', pg_temp.try($q$select public.set_feature_viewer('cost_management','97999999-0000-0000-0000-000000000003',true)$q$)||'|'||pg_temp.val($q$select count(*)::text from public.list_feature_viewers('cost_management')$q$)),
 ('A매니저(허용됨)','재고 평가를 읽는다','ALLOWED|1', pg_temp.try($q$select * from public.get_inventory_valuation()$q$)||'|'||pg_temp.val($q$select count(*)::text from public.get_inventory_valuation()$q$)),
 ('A매니저(허용됨)','주문 마진을 읽는다','ALLOWED', pg_temp.try($q$select * from public.get_order_margin('e7999999-0000-0000-0000-000000000001')$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원(허용 안 됨)','허용 안 된 직원은 쓸 수 없다','false|', pg_temp.val($q$select public.can_use_feature('a7999999-0000-0000-0000-000000000001','cost_management')::text$q$)||'|'),
 ('A직원(허용 안 됨)','내가 쓸 수 있는 기능 목록이 비어 있다','<null>', pg_temp.val($q$select string_agg(feature_key, ',') from public.my_usable_features()$q$)),
 ('A직원(허용 안 됨)','재고 평가·박스 목록·주문 마진 → 거부','DENIED: NOT_ALLOWED|DENIED: NOT_ALLOWED|DENIED: NOT_OWNER', pg_temp.try($q$select * from public.get_inventory_valuation()$q$)||'|'||pg_temp.try($q$select * from public.get_inventory_valuation_boxes('c7999999-0000-0000-0000-000000000001')$q$)||'|'||pg_temp.try($q$select * from public.get_order_margin('e7999999-0000-0000-0000-000000000001')$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('B대표','타사 대표: A사 주문 마진 → 거부, 자기 재고 평가는 0건(남의 재고가 안 섞임)','DENIED: NOT_OWNER|0', pg_temp.try($q$select * from public.get_order_margin('e7999999-0000-0000-0000-000000000001')$q$)||'|'||pg_temp.val($q$select count(*)::text from public.get_inventory_valuation()$q$)),
 ('B대표','A사 대표가 허용한 사람 목록을 B가 보면 → 0건','0', pg_temp.val($q$select count(*)::text from public.list_feature_viewers('cost_management')$q$));

-- ========== 7-C. 재고 평가 숫자 (대표) ==========
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표','상품 요약: 박스 3, 남은 18kg, 단가 있는 15kg, 평가 650,000원, 단가 없는 3kg, 박스 없는 2kg, 가장 오래된 박스 40일','3|18.000|15.000|650000|3.000|2.000|40',
   pg_temp.val($q$select box_count||'|'||remaining_qty||'|'||valued_qty||'|'||value_amount::int||'|'||unpriced_qty||'|'||boxless_qty||'|'||oldest_days from public.get_inventory_valuation()$q$)),
 ('A대표','취소된 박스(7kg)와 다 나간 박스(0kg)는 평가에서 빠진다','3', pg_temp.val($q$select count(*)::text from public.get_inventory_valuation_boxes('c7999999-0000-0000-0000-000000000001')$q$)),
 ('A대표','박스 목록은 오래된 순: 40일·5일·1일, 세 번째는 단가 없음','40|5|1|<null>', pg_temp.val($q$select string_agg(days_old::text, '|' order by created_at)||'|'||coalesce((array_agg(unit_price order by created_at desc))[1]::text, '<null>') from public.get_inventory_valuation_boxes('c7999999-0000-0000-0000-000000000001')$q$)),
 ('A대표','박스 목록 상한: 1건만 요청하면 1건, 전체 개수는 3','1|3', pg_temp.val($q$select count(*)||'|'||max(total_count) from public.get_inventory_valuation_boxes('c7999999-0000-0000-0000-000000000001', 1)$q$)),
 ('A대표','박스 목록 첫 줄 평가금액 = 10kg × 40,000','400000', pg_temp.val($q$select value_amount::int::text from public.get_inventory_valuation_boxes('c7999999-0000-0000-0000-000000000001') order by created_at limit 1$q$));

-- ========== 7-D. 운영자가 끄면 대표도 못 쓴다 / 허용 목록도 잠긴다 ==========
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('운영자','A업체의 원가 관리를 끄기 → 허용','ALLOWED', pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',false)$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표(꺼짐)','꺼지면 대표도 재고 평가·마진 → 거부','DENIED: FEATURE_DISABLED|DENIED: FEATURE_DISABLED', pg_temp.try($q$select * from public.get_inventory_valuation()$q$)||'|'||pg_temp.try($q$select * from public.get_order_margin('e7999999-0000-0000-0000-000000000001')$q$)),
 ('A대표(꺼짐)','꺼진 기능은 내 기능 목록에서 빠진다','<null>', pg_temp.val($q$select string_agg(feature_key, ',') from public.my_usable_features()$q$)),
 ('A대표(꺼짐)','꺼진 기능은 허용 목록을 바꿀 수 없다','DENIED: FEATURE_DISABLED', pg_temp.try($q$select public.set_feature_viewer('cost_management','97999999-0000-0000-0000-000000000003',true)$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저(꺼짐)','허용돼 있던 매니저도 꺼지면 못 쓴다','false', pg_temp.val($q$select public.can_use_feature('a7999999-0000-0000-0000-000000000001','cost_management')::text$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000005';
select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',true);
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
select public.set_feature_viewer('cost_management','97999999-0000-0000-0000-000000000002',false);
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저(해제됨)','다시 켠 뒤 대표가 허용을 해제하면 매니저는 못 쓴다','false|DENIED: NOT_ALLOWED', pg_temp.val($q$select public.can_use_feature('a7999999-0000-0000-0000-000000000001','cost_management')::text$q$)||'|'||pg_temp.try($q$select * from public.get_inventory_valuation()$q$));

-- ========== 7-F. 켜진 기간 이력 (언제부터 언제까지, 누가 켜고 껐는지) ==========
-- 여기까지의 흐름: A·B는 만들어질 때 기본 켜짐 기간이 열렸고(시스템), 운영자가 A를 껐다가(7-D) 다시 켰다.
reset role;
set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('운영자','A업체 이력: 2건(기본 켜짐 기간이 닫히고, 다시 켠 기간이 열림)','2|1', pg_temp.val($q$select count(*)||'|'||count(*) filter (where ended_at is null) from public.admin_list_feature_periods('a7999999-0000-0000-0000-000000000001')$q$)),
 ('운영자','처음 기간은 시스템(기본값)이 켰고 운영자가 껐다','시스템(기본값)|운영자', pg_temp.val($q$select started_by_name||'|'||ended_by_name from public.admin_list_feature_periods('a7999999-0000-0000-0000-000000000001') where ended_at is not null$q$)),
 ('운영자','다시 켠 기간은 운영자가 켰고 아직 끝나지 않았다','운영자|<null>', pg_temp.val($q$select started_by_name||'|'||coalesce(ended_by_name,'<null>') from public.admin_list_feature_periods('a7999999-0000-0000-0000-000000000001') where ended_at is null$q$)),
 ('운영자','B업체는 한 번도 안 바꿨으니 기본 켜짐 기간 1건이 진행 중','1|1', pg_temp.val($q$select count(*)||'|'||count(*) filter (where ended_at is null) from public.admin_list_feature_periods('a7999999-0000-0000-0000-000000000002')$q$)),
 ('운영자','이미 켜진 기능을 또 켜도 새 기간이 생기지 않는다','ALLOWED|2', pg_temp.try($q$select public.set_wholesaler_feature('a7999999-0000-0000-0000-000000000001','cost_management',true)$q$)||'|'||pg_temp.val($q$select count(*)::text from public.admin_list_feature_periods('a7999999-0000-0000-0000-000000000001')$q$)),
 ('운영자','불변식 점검: 켜져 있는데 기간이 없거나 꺼져 있는데 기간이 열린 곳 → 0건','0', pg_temp.val($q$select count(*)::text from public.feature_period_violations() where wholesaler_id in ('a7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000002')$q$));
set request.jwt.claim.sub = '97999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A대표','업체 대표가 이력 조회·불변식 점검 → 거부(운영자 전용)','DENIED: FORBIDDEN|DENIED: FORBIDDEN', pg_temp.try($q$select * from public.admin_list_feature_periods()$q$)||'|'||pg_temp.try($q$select * from public.feature_period_violations()$q$)),
 ('A대표','이력 표 직접 조회·쓰기 → 거부','DENIED|DENIED', pg_temp.try($q$select * from public.wholesaler_feature_periods$q$)||'|'||pg_temp.try($q$delete from public.wholesaler_feature_periods$q$));
reset role;
-- 기록은 고칠 수 없다: 이미 닫힌 기간의 값 변경, 시작 시각 변경, 닫힌 기간을 다시 닫기 모두 거부
insert into results (who,what,expected,result) values
 ('시스템','닫힌 기간의 끝 시각 고치기 → 거부','DENIED: HISTORY_IMMUTABLE', pg_temp.try($q$update public.wholesaler_feature_periods set ended_at = now() + interval '1 day' where wholesaler_id='a7999999-0000-0000-0000-000000000001' and ended_at is not null$q$)),
 ('시스템','진행 중 기간의 시작 시각 고치기 → 거부','DENIED: HISTORY_IMMUTABLE', pg_temp.try($q$update public.wholesaler_feature_periods set started_at = started_at - interval '10 days' where wholesaler_id='a7999999-0000-0000-0000-000000000002' and ended_at is null$q$)),
 ('시스템','진행 중 기간의 켠 사람 바꾸기 → 거부','DENIED: HISTORY_IMMUTABLE', pg_temp.try($q$update public.wholesaler_feature_periods set started_by = '97999999-0000-0000-0000-000000000001' where wholesaler_id='a7999999-0000-0000-0000-000000000002' and ended_at is null$q$));

-- ========== 7-E. 업체는 서로 독립이다 ==========
reset role;
insert into results (who,what,expected,result) values
 ('시스템','A업체만 껐다 켰어도 B업체 상태는 그대로(행 없음 = 기본값)','0', (select count(*)::text from public.wholesaler_features where wholesaler_id='a7999999-0000-0000-0000-000000000002'));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%')
                 or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%')
                 or (expected = 'DENIED|DENIED|DENIED' and result like 'DENIED%|DENIED%|DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')
                 or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%')
                 or (expected = 'DENIED|DENIED|DENIED' and result like 'DENIED%|DENIED%|DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%')
                 or (expected = 'DENIED|DENIED' and result like 'DENIED%|DENIED%')
                 or (expected = 'DENIED|DENIED|DENIED' and result like 'DENIED%|DENIED%|DENIED%'))) as fail
  from results;
