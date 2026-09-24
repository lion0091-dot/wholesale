-- 8. 관리자(슈퍼관리자) 기능 통합테스트 — 일반 계정의 관리자 기능 호출 거부 + 재승인·재처리 멱등
--    대상: 공급사 승인/국세청 검증 RPC, 플랫폼 이벤트, 구독 청구서, 문자 큐, 카테고리, 입점 희망 리드, 관리자 명단 RPC
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-admin.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
--
-- expected 칸은 "설계상 이래야 한다". FAIL이 나오면 그 줄이 곧 발견 사항이다.
-- [정보]는 현재 동작을 그대로 적은 것(판단 사항), [발견 후보]는 설계 기대와 다르면 FAIL로 드러나는 것.
-- 한 트랜잭션 안이라 now()가 고정이므로 "덮어썼는가"는 시각이 아니라 행위자(verified_by/collected_by)로 본다.
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

create function pg_temp.rows(p_sql text) returns text language plpgsql as $$
declare v bigint;
begin
    execute 'with u as (' || p_sql || ' returning 1) select count(*) from u' into v;
    return v::text;
exception when others then
    return 'ERROR: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- ========== 시드 (이 스크립트 전용 ID 접두어 90) ==========
insert into auth.users (id,email) values
 ('90999999-0000-0000-0000-000000000001','super1@adm.test'),
 ('90999999-0000-0000-0000-000000000002','super2@adm.test'),
 ('90999999-0000-0000-0000-000000000003','owner-a@adm.test'),
 ('90999999-0000-0000-0000-000000000004','manager-a@adm.test'),
 ('90999999-0000-0000-0000-000000000005','staff-a@adm.test'),
 ('90999999-0000-0000-0000-000000000006','retailer-r@adm.test'),
 ('90999999-0000-0000-0000-000000000007','owner-b@adm.test'),
 ('90999999-0000-0000-0000-000000000008','candidate@adm.test'),
 ('90999999-0000-0000-0000-000000000009','noprofile@adm.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_verified) values
 ('90999999-0000-0000-0000-000000000001','super_admin','관리자1','010',true),
 ('90999999-0000-0000-0000-000000000002','super_admin','관리자2','010',true),
 ('90999999-0000-0000-0000-000000000003','wholesaler','A사장','010',false),
 ('90999999-0000-0000-0000-000000000004','wholesaler','A매니저','010',false),
 ('90999999-0000-0000-0000-000000000005','wholesaler','A직원','010',false),
 ('90999999-0000-0000-0000-000000000006','retailer','식당R','010',false),
 ('90999999-0000-0000-0000-000000000007','wholesaler','B사장','010',false),
 ('90999999-0000-0000-0000-000000000008','wholesaler','후보','010',false)
 on conflict (id) do update set role=excluded.role, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.platform_admin_allowlist (user_id, can_grant, source) values
 ('90999999-0000-0000-0000-000000000001', true,  'admin_grant'),
 ('90999999-0000-0000-0000-000000000002', false, 'admin_grant');
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,subscription_status,nts_verification_status) values
 ('a9099999-0000-0000-0000-000000000001','90999999-0000-0000-0000-000000000003','A축산','9090000001','A','pending','trial','unchecked'),
 ('a9099999-0000-0000-0000-000000000002','90999999-0000-0000-0000-000000000007','B축산','9090000002','B','pending','trial','unchecked');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('09099999-0000-0000-0000-000000000001','a9099999-0000-0000-0000-000000000001','A축산','9090000001'),
 ('09099999-0000-0000-0000-000000000002','a9099999-0000-0000-0000-000000000002','B축산','9090000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('09099999-0000-0000-0000-000000000001','90999999-0000-0000-0000-000000000004','manager'),
 ('09099999-0000-0000-0000-000000000001','90999999-0000-0000-0000-000000000005','staff');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d9099999-0000-0000-0000-000000000001','90999999-0000-0000-0000-000000000006','식당R','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status,credit_limit,outstanding_balance) values
 ('a9099999-0000-0000-0000-000000000001','d9099999-0000-0000-0000-000000000001','active',0,0);
insert into public.platform_subscription_invoices (id,wholesaler_id,billing_month,billed_retailer_count,full_month_fee,amount) values
 ('f9099999-0000-0000-0000-000000000001','a9099999-0000-0000-0000-000000000001','2026-08-01',1,5000,5000),
 ('f9099999-0000-0000-0000-000000000002','a9099999-0000-0000-0000-000000000001','2026-09-01',1,5000,5000);
insert into public.platform_events (id,name,discount_rate,event_type,starts_on,duration_days) values
 ('e9099999-0000-0000-0000-000000000001','테스트 공통 이벤트',50,'common', current_date, 30);
insert into public.retailer_match_requests (id,restaurant_name,contact_name,contact_phone,region,desired_category) values
 ('19099999-0000-0000-0000-000000000001','시드 리드','담당','01000000000','서울','소');
insert into public.product_categories (id,name,sort_order) values ('c9099999-0000-0000-0000-000000000001','시드분류',99);

-- 상태별 공급사 (112 검증) — S 정지, C 해지, X 거절, P 승인대기
insert into auth.users (id,email) values
 ('90999999-0000-0000-0000-0000000000b1','os@adm.test'),('90999999-0000-0000-0000-0000000000b2','oc@adm.test'),
 ('90999999-0000-0000-0000-0000000000b3','ox@adm.test'),('90999999-0000-0000-0000-0000000000b4','op@adm.test'),
 ('90999999-0000-0000-0000-0000000000b5','ms@adm.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_verified) values
 ('90999999-0000-0000-0000-0000000000b1','wholesaler','정지사장','010',true),('90999999-0000-0000-0000-0000000000b2','wholesaler','해지사장','010',true),
 ('90999999-0000-0000-0000-0000000000b3','wholesaler','거절사장','010',false),('90999999-0000-0000-0000-0000000000b4','wholesaler','대기사장','010',false),
 ('90999999-0000-0000-0000-0000000000b5','wholesaler','정지매니저','010',true)
 on conflict (id) do update set role=excluded.role,is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,subscription_status,min_order_amount) values
 ('a9099999-0000-0000-0000-0000000000b1','90999999-0000-0000-0000-0000000000b1','정지축산','9090000011','S','suspended','active',0),
 ('a9099999-0000-0000-0000-0000000000b2','90999999-0000-0000-0000-0000000000b2','해지축산','9090000012','C','closed','cancelled',0),
 ('a9099999-0000-0000-0000-0000000000b3','90999999-0000-0000-0000-0000000000b3','거절축산','9090000013','X','rejected','trial',0),
 ('a9099999-0000-0000-0000-0000000000b4','90999999-0000-0000-0000-0000000000b4','대기축산','9090000014','P','pending','trial',0);
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('09099999-0000-0000-0000-0000000000b1','a9099999-0000-0000-0000-0000000000b1','정지축산','9090000011');
insert into public.organization_staff (organization_id,user_id,role) values
 ('09099999-0000-0000-0000-0000000000b1','90999999-0000-0000-0000-0000000000b5','manager');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status,credit_limit,outstanding_balance)
select w, 'd9099999-0000-0000-0000-000000000001','active',0,0 from unnest(array['a9099999-0000-0000-0000-0000000000b1','a9099999-0000-0000-0000-0000000000b2','a9099999-0000-0000-0000-0000000000b3','a9099999-0000-0000-0000-0000000000b4']::uuid[]) w;
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity)
select ('c9099999-0000-0000-0000-0000000000'||n)::uuid, w, '상태 테스트 상품','소','등심','국내산',1000,'kg',10
  from (values ('b1','a9099999-0000-0000-0000-0000000000b1'::uuid),('b2','a9099999-0000-0000-0000-0000000000b2'::uuid),('b3','a9099999-0000-0000-0000-0000000000b3'::uuid),('b4','a9099999-0000-0000-0000-0000000000b4'::uuid)) t(n,w);

-- ========== 1. 비관리자의 관리자 기능 호출 (공급사 사장 / 매니저 / 직원 / 고객 / 비로그인) ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A사장','자기 업체를 스스로 승인(set_supplier_verification) → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true)$q$)),
 ('A사장','자기 국세청 검증을 match로(set_nts_verification_result) → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_nts_verification_result('a9099999-0000-0000-0000-000000000001', 'match')$q$)),
 ('A사장','플랫폼 이벤트 취소 → 거부','DENIED: PLATFORM_ADMIN_ONLY', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-000000000001')$q$)),
 ('A사장','관리자 부여 권한 보유 여부 → false','false', pg_temp.val($q$select public.can_current_user_grant_admin()::text$q$)),
 ('A사장','관리자 부여 RPC 직접 호출 → 실행 권한 없음','DENIED: permission denied for function grant_platform_admin', pg_temp.try($q$select public.grant_platform_admin('90999999-0000-0000-0000-000000000003','90999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','관리자 승격 RPC 직접 호출 → 실행 권한 없음','DENIED: permission denied for function promote_platform_admin', pg_temp.try($q$select public.promote_platform_admin('90999999-0000-0000-0000-000000000003')$q$)),
 ('A사장','관리자 회수 RPC 직접 호출 → 실행 권한 없음','DENIED: permission denied for function revoke_platform_admin', pg_temp.try($q$select public.revoke_platform_admin('90999999-0000-0000-0000-000000000001','90999999-0000-0000-0000-000000000003')$q$)),
 ('A사장','관리자 명단 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.platform_admin_allowlist$q$)),
 ('A사장','플랫폼 이벤트 신규 등록 → 거부','DENIED: new row violates row-level security policy for table "platform_events"', pg_temp.try($q$insert into public.platform_events (name,discount_rate,event_type,starts_on,duration_days) values ('위조',100,'common',current_date,30)$q$)),
 ('A사장','이벤트 대상 공급사 등록 → 거부','DENIED: new row violates row-level security policy for table "platform_event_suppliers"', pg_temp.try($q$insert into public.platform_event_suppliers (event_id,wholesaler_id,discount_rate) values ('e9099999-0000-0000-0000-000000000001','a9099999-0000-0000-0000-000000000001',100)$q$)),
 ('A사장','구독 청구서 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.platform_subscription_invoices$q$)),
 ('A사장','자기 청구서를 완납으로 → 0행','0', pg_temp.rows($q$update public.platform_subscription_invoices set status='paid', paid_amount=5000 where id='f9099999-0000-0000-0000-000000000001'$q$)),
 ('A사장','상품 분류 추가 → 거부','DENIED: new row violates row-level security policy for table "product_categories"', pg_temp.try($q$insert into public.product_categories (name) values ('위조분류')$q$)),
 ('A사장','상품 분류 삭제 → 0행','0', pg_temp.rows($q$delete from public.product_categories where id='c9099999-0000-0000-0000-000000000001'$q$)),
 ('A사장','상품 분류 조회(공개 마스터, 허용) → 1건 이상','ok', pg_temp.val($q$select case when count(*)>=1 then 'ok' else 'none' end from public.product_categories$q$)),
 ('A사장','입점 희망 리드 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.retailer_match_requests$q$)),
 ('A사장','입점 희망 리드 상태 변경 → 0행','0', pg_temp.rows($q$update public.retailer_match_requests set status='matched' where id='19099999-0000-0000-0000-000000000001'$q$)),
 ('A사장','청구서 문자를 큐에 등록(billing_invoice는 관리자 전용) → 거부','DENIED: new row violates row-level security policy for table "outbound_sms_queue"', pg_temp.try($q$insert into public.outbound_sms_queue (message_type,wholesaler_id,recipient_name,recipient_phone,message_body) values ('billing_invoice','a9099999-0000-0000-0000-000000000001','A','01000000000','위조')$q$)),
 ('A사장','타 공급사(B) 명의로 초청 문자 큐 등록 → 거부','DENIED: new row violates row-level security policy for table "outbound_sms_queue"', pg_temp.try($q$insert into public.outbound_sms_queue (message_type,wholesaler_id,recipient_name,recipient_phone,message_body) values ('retailer_invite','a9099999-0000-0000-0000-000000000002','X','01000000000','타사')$q$)),
 ('A사장','[정보] 자기 공급사 명의 초청 문자 큐 등록(허용 설계)','ALLOWED', pg_temp.try($q$insert into public.outbound_sms_queue (message_type,wholesaler_id,retailer_id,recipient_name,recipient_phone,message_body) values ('retailer_invite','a9099999-0000-0000-0000-000000000001','d9099999-0000-0000-0000-000000000001','식당','01000000000','초청')$q$)),
 ('A사장','다른 사람 프로필 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.profiles where id<>'90999999-0000-0000-0000-000000000003'$q$));

set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('A매니저','업체 승인 RPC → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true)$q$)),
 ('A매니저','국세청 검증 결과 RPC → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_nts_verification_result('a9099999-0000-0000-0000-000000000001', 'match')$q$)),
 ('A매니저','이벤트 취소 → 거부','DENIED: PLATFORM_ADMIN_ONLY', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-000000000001')$q$)),
 ('A매니저','청구서 완납 처리 → 0행','0', pg_temp.rows($q$update public.platform_subscription_invoices set status='paid' where id='f9099999-0000-0000-0000-000000000001'$q$)),
 ('A매니저','상품 분류 추가 → 거부','DENIED: new row violates row-level security policy for table "product_categories"', pg_temp.try($q$insert into public.product_categories (name) values ('위조분류')$q$));

set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A직원','업체 승인 RPC → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true)$q$)),
 ('A직원','국세청 검증 결과 RPC → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_nts_verification_result('a9099999-0000-0000-0000-000000000001', 'match')$q$)),
 ('A직원','이벤트 취소 → 거부','DENIED: PLATFORM_ADMIN_ONLY', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-000000000001')$q$)),
 ('A직원','리드 상태 변경 → 0행','0', pg_temp.rows($q$update public.retailer_match_requests set status='matched'$q$));

set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('식당R','업체 승인 RPC → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true)$q$)),
 ('식당R','이벤트 취소 → 거부','DENIED: PLATFORM_ADMIN_ONLY', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-000000000001')$q$)),
 ('식당R','[정보] 진행 중 공통 이벤트는 공개 조회(허용 설계) → 1건','1', pg_temp.val($q$select count(*)::text from public.platform_events where id='e9099999-0000-0000-0000-000000000001'$q$)),
 ('식당R','리드 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.retailer_match_requests$q$)),
 ('식당R','청구서 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.platform_subscription_invoices$q$));
reset role;

set role anon; reset request.jwt.claim.sub; reset request.jwt.claim.role;
insert into results (who,what,expected,result) values
 ('비로그인','업체 승인 RPC → 거부(실행 권한 없음)','DENIED', pg_temp.try($q$select public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true)$q$)),
 ('비로그인','국세청 검증 결과 RPC → 거부','DENIED', pg_temp.try($q$select public.set_nts_verification_result('a9099999-0000-0000-0000-000000000001', 'match')$q$)),
 ('비로그인','이벤트 취소 → 거부','DENIED', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-000000000001')$q$)),
 ('비로그인','관리자 부여 권한 여부 → false','false', pg_temp.val($q$select public.can_current_user_grant_admin()::text$q$)),
 ('비로그인','관리자 부여 RPC → 실행 권한 없음','DENIED: permission denied for function grant_platform_admin', pg_temp.try($q$select public.grant_platform_admin('90999999-0000-0000-0000-000000000003','90999999-0000-0000-0000-000000000001')$q$)),
 ('비로그인','청구서 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.platform_subscription_invoices$q$)),
 ('비로그인','상품 분류 추가 → 거부','DENIED: new row violates row-level security policy for table "product_categories"', pg_temp.try($q$insert into public.product_categories (name) values ('위조분류')$q$)),
 ('비로그인','리드 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.retailer_match_requests$q$)),
 ('비로그인','관리자 전용 컬럼(status·admin_note)을 채운 리드 제출 → 거부','DENIED: new row violates row-level security policy for table "retailer_match_requests"', pg_temp.try($q$insert into public.retailer_match_requests (id,restaurant_name,contact_name,contact_phone,region,desired_category,status,admin_note) values ('19099999-0000-0000-0000-000000000002','익명 위조 리드','x','01000000000','서울','소','matched','관리자가 처리함')$q$)),
 ('비로그인','[정보] 정상 리드 제출은 비로그인 허용 설계 → 허용','ALLOWED', pg_temp.try($q$insert into public.retailer_match_requests (id,restaurant_name,contact_name,contact_phone,region,desired_category) values ('19099999-0000-0000-0000-000000000003','익명 정상 리드','x','01000000000','서울','소')$q$));reset role;
-- 익명이 관리자 전용 컬럼(status, admin_note)을 직접 채웠는데 그대로 저장됐나
insert into results (who,what,expected,result) values
 ('비로그인','위조 리드는 저장되지 않음 → 0건','0', (select count(*)::text from public.retailer_match_requests where id='19099999-0000-0000-0000-000000000002')),
 ('비로그인','정상 리드는 pending으로 저장','pending|<null>', (select status || '|' || coalesce(admin_note,'<null>') from public.retailer_match_requests where id='19099999-0000-0000-0000-000000000003'));

-- 프로필 행이 없는 로그인 계정(role이 NULL) — NULL 비교로 검사가 통과하던 경로
delete from public.profiles where id='90999999-0000-0000-0000-000000000009';
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000009';
insert into results (who,what,expected,result) values
 ('프로필 없는 계정','업체 승인 RPC → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true)$q$)),
 ('프로필 없는 계정','국세청 검증 결과 RPC → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_nts_verification_result('a9099999-0000-0000-0000-000000000001', 'match')$q$)),
 ('프로필 없는 계정','이벤트 취소 → 거부','DENIED: PLATFORM_ADMIN_ONLY', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-000000000001')$q$));
reset role;

-- ========== 2. 관리자 정상 동작 + 재승인 멱등 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('관리자1','A사 승인 → 대표+매니저+직원 3계정 전파','3', pg_temp.val($q$select (public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true))->>'updated'$q$)),
 ('관리자1','승인 후 3계정 is_verified=true','3', pg_temp.val($q$select count(*)::text from public.profiles where id in ('90999999-0000-0000-0000-000000000003','90999999-0000-0000-0000-000000000004','90999999-0000-0000-0000-000000000005') and is_verified$q$)),
 ('관리자1','승인자(verified_by)가 관리자1로 기록','90999999-0000-0000-0000-000000000001', pg_temp.val($q$select verified_by::text from public.profiles where id='90999999-0000-0000-0000-000000000003'$q$)),
 ('관리자1','승인 대상 계정에 관리자 계정은 포함되지 않음(관리자1의 is_verified 그대로) → true','true', pg_temp.val($q$select is_verified::text from public.profiles where id='90999999-0000-0000-0000-000000000001'$q$));

set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('관리자2','같은 업체를 다시 승인(재승인) → 오류 없이 3계정','3', pg_temp.val($q$select (public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true))->>'updated'$q$)),
 ('관리자2','재승인해도 최초 승인자(관리자1)가 유지돼야 함','90999999-0000-0000-0000-000000000001', pg_temp.val($q$select verified_by::text from public.profiles where id='90999999-0000-0000-0000-000000000003'$q$)),
 ('관리자2','재승인 후에도 3계정 승인 상태 유지','3', pg_temp.val($q$select count(*)::text from public.profiles where id in ('90999999-0000-0000-0000-000000000003','90999999-0000-0000-0000-000000000004','90999999-0000-0000-0000-000000000005') and is_verified$q$)),
 ('관리자2','승인 취소 → 3계정','3', pg_temp.val($q$select (public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', false))->>'updated'$q$)),
 ('관리자2','승인 취소 후 3계정 모두 is_verified=false','0', pg_temp.val($q$select count(*)::text from public.profiles where id in ('90999999-0000-0000-0000-000000000003','90999999-0000-0000-0000-000000000004','90999999-0000-0000-0000-000000000005') and is_verified$q$)),
 ('관리자2','승인 취소 후 승인자·승인시각 기록이 비워짐','0', pg_temp.val($q$select count(*)::text from public.profiles where id in ('90999999-0000-0000-0000-000000000003','90999999-0000-0000-0000-000000000004','90999999-0000-0000-0000-000000000005') and (verified_by is not null or verified_at is not null)$q$)),
 ('관리자2','승인 취소 후 재승인 → 3계정 복구','3', pg_temp.val($q$select (public.set_supplier_verification('a9099999-0000-0000-0000-000000000001', true))->>'updated'$q$)),
 ('관리자2','취소 뒤 새로 승인한 기록은 새 승인자(관리자2)로','90999999-0000-0000-0000-000000000002', pg_temp.val($q$select verified_by::text from public.profiles where id='90999999-0000-0000-0000-000000000003'$q$)),
 ('관리자2','[정보] 존재하지 않는 업체 승인 호출 → 오류 없이 0계정(현재 동작)','0', pg_temp.val($q$select (public.set_supplier_verification('a9099999-0000-0000-0000-0000000000ff', true))->>'updated'$q$)),
 ('관리자2','[정보] RPC 자체는 국세청 검증 없이도 승인 처리(검증 게이트는 서버 액션에만, 관리자 전용이라 허용)','1', pg_temp.val($q$select (public.set_supplier_verification('a9099999-0000-0000-0000-000000000002', true))->>'updated'$q$)),
 ('관리자2','국세청 결과 match 저장','match', pg_temp.val($q$select (public.set_nts_verification_result('a9099999-0000-0000-0000-000000000001','match'))->>'nts_verification_status'$q$)),
 ('관리자2','국세청 결과 같은 값 재저장(멱등) → match 유지','match', pg_temp.val($q$select (public.set_nts_verification_result('a9099999-0000-0000-0000-000000000001','match'))->>'nts_verification_status'$q$)),
 ('관리자2','국세청 결과에 임의 문자열 → 거부','DENIED: INVALID_NTS_STATUS', pg_temp.try($q$select public.set_nts_verification_result('a9099999-0000-0000-0000-000000000001','ok')$q$)),
 ('관리자2','없는 업체의 국세청 결과 → 거부','DENIED: SUPPLIER_NOT_FOUND', pg_temp.try($q$select public.set_nts_verification_result('a9099999-0000-0000-0000-0000000000ff','match')$q$)),
 ('관리자2','업체 상태(status)를 active로(서버 액션이 하는 UPDATE) → 1행','1', pg_temp.rows($q$update public.wholesalers set status='active' where id='a9099999-0000-0000-0000-000000000001'$q$)),
 ('관리자2','업체 상태 같은 값 재변경(재승인) → 1행, 오류 없음','1', pg_temp.rows($q$update public.wholesalers set status='active' where id='a9099999-0000-0000-0000-000000000001'$q$)),
 ('관리자2','업체 상태에 정의 밖 값 → 거부','DENIED: new row for relation "wholesalers" violates check constraint "wholesalers_status_check"', pg_temp.try($q$update public.wholesalers set status='approved' where id='a9099999-0000-0000-0000-000000000001'$q$)),
 ('관리자2','구독 상태에 정의 밖 값 → 거부','DENIED: new row for relation "wholesalers" violates check constraint "wholesalers_subscription_status_check"', pg_temp.try($q$update public.wholesalers set subscription_status='vip' where id='a9099999-0000-0000-0000-000000000001'$q$));

-- 이벤트
set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('관리자1','이벤트 취소 → 성공','ALLOWED', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-000000000001')$q$)),
 ('관리자1','같은 이벤트 다시 취소 → 거부(이미 취소)','DENIED: EVENT_NOT_FOUND_OR_ALREADY_CANCELLED', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-000000000001')$q$)),
 ('관리자1','없는 이벤트 취소 → 거부','DENIED: EVENT_NOT_FOUND_OR_ALREADY_CANCELLED', pg_temp.try($q$select public.cancel_platform_event('e9099999-0000-0000-0000-0000000000ff')$q$)),
 ('관리자1','취소된 이벤트 상태·취소자 기록','cancelled|90999999-0000-0000-0000-000000000001', pg_temp.val($q$select status || '|' || cancelled_by::text from public.platform_events where id='e9099999-0000-0000-0000-000000000001'$q$)),
 ('관리자1','이벤트 할인율 100 초과 등록 → 거부','DENIED: new row for relation "platform_events" violates check constraint "platform_events_discount_rate_check"', pg_temp.try($q$insert into public.platform_events (name,discount_rate,event_type,starts_on,duration_days) values ('과다',150,'common',current_date,30)$q$));

set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('식당R','취소된 공통 이벤트는 더 이상 공개 조회되지 않음 → 0건','0', pg_temp.val($q$select count(*)::text from public.platform_events where id='e9099999-0000-0000-0000-000000000001'$q$));

-- 청구서 수납
set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('관리자1','청구서 완납 처리(액션과 같은 UPDATE) → 1행','1', pg_temp.rows($q$update public.platform_subscription_invoices set status='paid', paid_at=now(), collected_by='90999999-0000-0000-0000-000000000001', paid_amount=5000 where id='f9099999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('관리자2','[정보] 이미 완납된 청구서를 다시 완납 처리 → 1행(현재는 덮어씀: 입금액 정정 용도로 허용)','1', pg_temp.rows($q$update public.platform_subscription_invoices set status='paid', paid_at=now(), collected_by='90999999-0000-0000-0000-000000000002', paid_amount=4000 where id='f9099999-0000-0000-0000-000000000001'$q$)),
 ('관리자2','[정보] 재완납 뒤 수납자·입금액이 마지막 처리값으로 바뀜','90999999-0000-0000-0000-000000000002|4000', pg_temp.val($q$select collected_by::text || '|' || paid_amount::text from public.platform_subscription_invoices where id='f9099999-0000-0000-0000-000000000001'$q$)),
 ('관리자2','음수 입금액으로 완납 처리 → 거부','DENIED', pg_temp.try($q$update public.platform_subscription_invoices set status='paid', paid_amount=-100 where id='f9099999-0000-0000-0000-000000000002'$q$)),
 ('관리자2','0원 입금액으로 완납 처리 → 거부','DENIED', pg_temp.try($q$update public.platform_subscription_invoices set status='paid', paid_amount=0 where id='f9099999-0000-0000-0000-000000000002'$q$)),
 ('관리자2','청구서 상태에 정의 밖 값 → 거부','DENIED: new row for relation "platform_subscription_invoices" violates check constraint "platform_subscription_invoices_status_check"', pg_temp.try($q$update public.platform_subscription_invoices set status='refunded' where id='f9099999-0000-0000-0000-000000000002'$q$)),
 ('관리자2','청구서 문자를 큐에 등록(billing_invoice) → 허용','ALLOWED', pg_temp.try($q$insert into public.outbound_sms_queue (message_type,wholesaler_id,recipient_name,recipient_phone,message_body,invoice_id) values ('billing_invoice','a9099999-0000-0000-0000-000000000001','A','01000000000','청구','f9099999-0000-0000-0000-000000000002')$q$)),
 ('관리자2','상품 분류 추가·삭제 → 허용','ALLOWED|1', pg_temp.try($q$insert into public.product_categories (name) values ('관리자분류')$q$) || '|' || pg_temp.rows($q$delete from public.product_categories where name='관리자분류'$q$)),
 ('관리자2','리드 상태 변경 → 1행','1', pg_temp.rows($q$update public.retailer_match_requests set status='matched', admin_note='관리자 처리' where id='19099999-0000-0000-0000-000000000001'$q$)),
 ('관리자2','관리자 명단 조회 → 2건','2', pg_temp.val($q$select count(*)::text from public.platform_admin_allowlist$q$)),
 ('관리자2','can_grant 없는 관리자의 부여 권한 여부 → false','false', pg_temp.val($q$select public.can_current_user_grant_admin()::text$q$));
set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('관리자1','can_grant 관리자의 부여 권한 여부 → true','true', pg_temp.val($q$select public.can_current_user_grant_admin()::text$q$));
reset role;

-- ========== 4. 정지·해지·거절 공급사의 DB 직접 쓰기 차단 (112) ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '90999999-0000-0000-0000-0000000000b1';
insert into results (who,what,expected,result) values
 ('정지 공급사 사장','상품 가격 수정 → 거부','ERROR: SUPPLIER_NOT_ACTIVE', pg_temp.rows($q$update public.products set base_price=2 where id='c9099999-0000-0000-0000-0000000000b1'$q$)),
 ('정지 공급사 사장','상품 등록 → 거부','DENIED: SUPPLIER_NOT_ACTIVE', pg_temp.try($q$insert into public.products (wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity) values ('a9099999-0000-0000-0000-0000000000b1','신규','소','안심','국내산',1,'kg',0)$q$)),
 ('정지 공급사 사장','상품 삭제 → 거부','ERROR: SUPPLIER_NOT_ACTIVE', pg_temp.rows($q$delete from public.products where id='c9099999-0000-0000-0000-0000000000b1'$q$));
set request.jwt.claim.sub = '90999999-0000-0000-0000-0000000000b5';
insert into results (who,what,expected,result) values
 ('정지 공급사 매니저','상품 가격 수정 → 거부','ERROR: SUPPLIER_NOT_ACTIVE', pg_temp.rows($q$update public.products set base_price=2 where id='c9099999-0000-0000-0000-0000000000b1'$q$));
set request.jwt.claim.sub = '90999999-0000-0000-0000-0000000000b2';
insert into results (who,what,expected,result) values
 ('해지 공급사 사장','상품 가격 수정 → 거부','ERROR: SUPPLIER_NOT_ACTIVE', pg_temp.rows($q$update public.products set base_price=2 where id='c9099999-0000-0000-0000-0000000000b2'$q$));
set request.jwt.claim.sub = '90999999-0000-0000-0000-0000000000b3';
insert into results (who,what,expected,result) values
 ('거절 공급사 사장','상품 가격 수정 → 거부','ERROR: SUPPLIER_NOT_ACTIVE', pg_temp.rows($q$update public.products set base_price=2 where id='c9099999-0000-0000-0000-0000000000b3'$q$));
set request.jwt.claim.sub = '90999999-0000-0000-0000-0000000000b4';
insert into results (who,what,expected,result) values
 ('승인대기 공급사 사장','상품 가격 수정 → 허용(기존 결정)','1', pg_temp.rows($q$update public.products set base_price=2 where id='c9099999-0000-0000-0000-0000000000b4'$q$)),
 ('승인대기 공급사 사장','상품 등록 → 허용(기존 결정)','ALLOWED', pg_temp.try($q$insert into public.products (wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity) values ('a9099999-0000-0000-0000-0000000000b4','신규','소','안심','국내산',1,'kg',0)$q$));

set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('식당R','정지 공급사에 주문 생성 → 거부','DENIED: SUPPLIER_NOT_ACTIVE', pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('a9099999-0000-0000-0000-0000000000b1','d9099999-0000-0000-0000-000000000001','SUSP-1',1000,'pending','서울')$q$)),
 ('식당R','해지 공급사에 주문 생성 → 거부','DENIED: SUPPLIER_NOT_ACTIVE', pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('a9099999-0000-0000-0000-0000000000b2','d9099999-0000-0000-0000-000000000001','SUSP-2',1000,'pending','서울')$q$)),
 ('식당R','거절 공급사에 주문 생성 → 거부','DENIED: SUPPLIER_NOT_ACTIVE', pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('a9099999-0000-0000-0000-0000000000b3','d9099999-0000-0000-0000-000000000001','SUSP-3',1000,'pending','서울')$q$)),
 ('식당R','승인대기 공급사에 주문 생성 → 이 트리거는 통과(앱이 막는 영역)','ALLOWED', pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('a9099999-0000-0000-0000-0000000000b4','d9099999-0000-0000-0000-000000000001','SUSP-4',1000,'pending','서울')$q$));

set request.jwt.claim.sub = '90999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('관리자1','[정보] 관리자 세션은 원래 타사 상품 수정 권한이 없음(RLS) → 0행, 트리거와 무관','0', pg_temp.rows($q$update public.products set base_price=3 where id='c9099999-0000-0000-0000-0000000000b1'$q$));
reset role;
insert into results (who,what,expected,result) values
 ('서버(소유자 권한)','정지 공급사 상품 수정 → 허용(재고 재계산 등 내부 경로)','1', pg_temp.rows($q$update public.products set stock_quantity=11 where id='c9099999-0000-0000-0000-0000000000b1'$q$));
set role service_role; set request.jwt.claim.role = 'service_role';
insert into results (who,what,expected,result) values
 ('service_role','정지 공급사 상품 수정 → 허용(서버 키)','1', pg_temp.rows($q$update public.products set stock_quantity=12 where id='c9099999-0000-0000-0000-0000000000b1'$q$)),
 ('service_role','정지 공급사에 주문 생성 → 허용(PG 결제 복구 크론 경로)','ALLOWED', pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values ('a9099999-0000-0000-0000-0000000000b1','d9099999-0000-0000-0000-000000000001','SUSP-5',1000,'pending','서울')$q$));
reset role;

update public.wholesalers set status='active' where id='a9099999-0000-0000-0000-0000000000b1';
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '90999999-0000-0000-0000-0000000000b1';
insert into results (who,what,expected,result) values
 ('정지 해제 후 사장','재활성화(active) 뒤 상품 수정 → 허용','1', pg_temp.rows($q$update public.products set base_price=4 where id='c9099999-0000-0000-0000-0000000000b1'$q$));
reset role;

-- ========== 3. 관리자 명단 RPC (서버 전용, service_role 권한) ==========
insert into results (who,what,expected,result) values
 ('청구서','같은 업체·같은 달 청구서 중복 생성 → 거부(유니크, 생성은 서버 전용 경로)','DENIED: duplicate key value violates unique constraint "platform_subscription_invoices_wholesaler_id_billing_month_key"', pg_temp.try($q$insert into public.platform_subscription_invoices (wholesaler_id,billing_month,billed_retailer_count,full_month_fee,amount) values ('a9099999-0000-0000-0000-000000000001','2026-08-01',1,5000,5000)$q$)),
 ('명단','자기 자신 회수 → 거부','DENIED: PLATFORM_ADMIN_SELF_REVOKE', pg_temp.try($q$select public.revoke_platform_admin('90999999-0000-0000-0000-000000000001','90999999-0000-0000-0000-000000000001')$q$)),
 ('명단','can_grant 없는 관리자가 부여 → 거부','DENIED: PLATFORM_ADMIN_GRANT_FORBIDDEN', pg_temp.try($q$select public.grant_platform_admin('90999999-0000-0000-0000-000000000008','90999999-0000-0000-0000-000000000002')$q$)),
 ('명단','can_grant 없는 관리자가 회수 → 거부','DENIED: PLATFORM_ADMIN_GRANT_FORBIDDEN', pg_temp.try($q$select public.revoke_platform_admin('90999999-0000-0000-0000-000000000001','90999999-0000-0000-0000-000000000002')$q$)),
 ('명단','관리자가 아닌 계정을 행위자로 지정해 부여 → 거부','DENIED: PLATFORM_ADMIN_GRANT_FORBIDDEN', pg_temp.try($q$select public.grant_platform_admin('90999999-0000-0000-0000-000000000008','90999999-0000-0000-0000-000000000003')$q$)),
 ('명단','존재하지 않는 계정에 부여 → 거부','DENIED: PLATFORM_ADMIN_USER_NOT_FOUND', pg_temp.try($q$select public.grant_platform_admin('90999999-0000-0000-0000-0000000000ff','90999999-0000-0000-0000-000000000001')$q$)),
 ('명단','승인 완료된 공급사 대표를 관리자로 승격 → 거부(이해충돌)','DENIED: PLATFORM_ADMIN_TARGET_ALREADY_VERIFIED', pg_temp.try($q$select public.grant_platform_admin('90999999-0000-0000-0000-000000000003','90999999-0000-0000-0000-000000000001')$q$)),
 ('명단','미승인 계정(후보) 관리자 부여 → 승격','true', pg_temp.val($q$select (public.grant_platform_admin('90999999-0000-0000-0000-000000000008','90999999-0000-0000-0000-000000000001'))->>'promoted'$q$)),
 ('명단','같은 계정 재부여(멱등) → 오류 없이 이미 관리자(promoted=false)','false', pg_temp.val($q$select (public.grant_platform_admin('90999999-0000-0000-0000-000000000008','90999999-0000-0000-0000-000000000001'))->>'promoted'$q$)),
 ('명단','후보 회수 → 강등 처리','true', pg_temp.val($q$select (public.revoke_platform_admin('90999999-0000-0000-0000-000000000008','90999999-0000-0000-0000-000000000001'))->>'demoted'$q$)),
 ('명단','이미 회수된 계정 다시 회수 → 거부','DENIED: PLATFORM_ADMIN_NOT_ALLOWLISTED', pg_temp.try($q$select public.revoke_platform_admin('90999999-0000-0000-0000-000000000008','90999999-0000-0000-0000-000000000001')$q$)),
 ('명단','회수 이력 보존(revoked_at 기록된 행 존재)','1', pg_temp.val($q$select count(*)::text from public.platform_admin_allowlist where user_id='90999999-0000-0000-0000-000000000008' and revoked_at is not null$q$)),
 ('명단','명단에 없는 일반 계정 승격 호출(로그인 경로) → 승격 안 됨','false', pg_temp.val($q$select (public.promote_platform_admin('90999999-0000-0000-0000-000000000006'))->>'promoted'$q$));

insert into results (who,what,expected,result) values
 ('명단','회수 후 역할 복귀(업체 레코드 없는 후보라 고객 계정으로)','retailer', (select role from public.profiles where id='90999999-0000-0000-0000-000000000008'));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
