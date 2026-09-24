-- 1. 가입·로그인 통합테스트 — DB 레벨(온보딩 RPC, 승인 게이트, 직원 초대, 바이어 가입, 동의 시점, 탈퇴 보존)
--    카카오 OAuth·국세청 API는 외부라 여기서 못 다룬다(그 결과를 기록하는 RPC까지만).
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-signup-and-accounts.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
--
-- expected 칸은 "설계상 이래야 한다". expected가 'DENIED'만이면 사유 무관하게 거부되면 PASS.
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

-- ========== 시드 (접두어 94) ==========
-- 카카오 로그인 직후 상태를 흉내: auth.users만 넣으면 on_auth_user_created → handle_new_user가 profiles를 만든다.
insert into auth.users (id,email,raw_user_meta_data) values
 ('94999999-0000-0000-0000-000000000001','owner-a@acct.test','{}'),
 ('94999999-0000-0000-0000-000000000002','manager-a@acct.test','{}'),
 ('94999999-0000-0000-0000-000000000003','staff-a@acct.test','{}'),
 ('94999999-0000-0000-0000-000000000004','staff-b@acct.test','{}'),
 ('94999999-0000-0000-0000-000000000005','newbie@acct.test','{"name":"김신규","phone_number":"01012345678"}'),
 ('94999999-0000-0000-0000-000000000006','invitee@acct.test','{"name":"박초대"}'),
 ('94999999-0000-0000-0000-000000000007','retailer@acct.test','{}'),
 ('94999999-0000-0000-0000-000000000008','super@acct.test','{}'),
 ('94999999-0000-0000-0000-000000000009','buyer-new@acct.test','{"name":"이손님"}'),
 ('94999999-0000-0000-0000-000000000010','staffchan@acct.test','{}'),
 ('94999999-0000-0000-0000-000000000012','invitee2@acct.test','{}'),
 ('94999999-0000-0000-0000-000000000013','owner-b@acct.test','{}');

-- 1-A. 동의 전 개인정보 미저장: 트리거가 만든 프로필은 이름·전화가 비어 있어야 한다
insert into results (who,what,expected,result) values
 ('신규','카카오 로그인 직후 profiles 이름·전화 비어 있음(동의 전 PII 미저장)','|', pg_temp.val($q$select name||'|'||phone from public.profiles where id='94999999-0000-0000-0000-000000000005'$q$)),
 ('신규','  └ 동의 시각 없음','<null>', pg_temp.val($q$select terms_agreed_at::text from public.profiles where id='94999999-0000-0000-0000-000000000005'$q$));

-- 나머지 계정의 역할을 시드로 고정
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified,signup_channel) values
 ('94999999-0000-0000-0000-000000000001','wholesaler','A사장','010',true,true,null),
 ('94999999-0000-0000-0000-000000000002','wholesaler','A매니저','010',true,true,null),
 ('94999999-0000-0000-0000-000000000003','wholesaler','A직원','010',true,true,null),
 ('94999999-0000-0000-0000-000000000004','wholesaler','B직원','010',true,true,null),
 ('94999999-0000-0000-0000-000000000007','retailer','식당R','010',false,false,null),
 ('94999999-0000-0000-0000-000000000008','super_admin','관리자','010',false,false,null),
 ('94999999-0000-0000-0000-000000000010','wholesaler','','',true,false,'staff'),
 ('94999999-0000-0000-0000-000000000013','wholesaler','B사장','010',true,true,null)
 on conflict (id) do update set role=excluded.role, name=excluded.name, phone=excluded.phone, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified, signup_channel=excluded.signup_channel;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,shop_token) values
 ('a4999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000001','A축산','9490000001','A','active','54999999-0000-0000-0000-000000000001'),
 ('a4999999-0000-0000-0000-000000000002','94999999-0000-0000-0000-000000000013','B축산','9490000002','B','active','54999999-0000-0000-0000-000000000002');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('04999999-0000-0000-0000-000000000001','a4999999-0000-0000-0000-000000000001','A축산','9490000001'),
 ('04999999-0000-0000-0000-000000000002','a4999999-0000-0000-0000-000000000002','B축산','9490000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('04999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000001','owner'),
 ('04999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000002','manager'),
 ('04999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000003','staff'),
 ('04999999-0000-0000-0000-000000000002','94999999-0000-0000-0000-000000000013','owner'),
 ('04999999-0000-0000-0000-000000000002','94999999-0000-0000-0000-000000000004','staff');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address,business_number) values
 ('d4999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000007','R식당','R사장','서울 어딘가','1234567890');
insert into public.wholesaler_retailers (id,wholesaler_id,retailer_id,status,credit_limit,outstanding_balance) values
 ('b4999999-0000-0000-0000-000000000001','a4999999-0000-0000-0000-000000000001','d4999999-0000-0000-0000-000000000001','active',1000000,50000);
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity) values
 ('c4999999-0000-0000-0000-000000000001','a4999999-0000-0000-0000-000000000001','A 등심','소','등심','국내산',68000,'kg',10),
 ('c4999999-0000-0000-0000-000000000002','a4999999-0000-0000-0000-000000000002','B 삼겹','돼지','삼겹살','국내산',20000,'kg',5);
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,payment_method) values
 ('e4999999-0000-0000-0000-000000000001','a4999999-0000-0000-0000-000000000001','d4999999-0000-0000-0000-000000000001','ACCT-1',68000,'delivered','서울 어딘가','on_credit');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e4999999-0000-0000-0000-000000000001','c4999999-0000-0000-0000-000000000001','A 등심',68000,1,68000);
-- 초대 링크: A사 owner가 만든 staff 초대(유효) / 만료된 것 / 취소된 것
insert into public.organization_staff_invites (id,organization_id,role,token,created_by,expires_at,revoked_at) values
 ('14999999-0000-0000-0000-000000000001','04999999-0000-0000-0000-000000000001','staff','24999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000001',now()+interval '7 days',null),
 ('14999999-0000-0000-0000-000000000002','04999999-0000-0000-0000-000000000001','staff','24999999-0000-0000-0000-000000000002','94999999-0000-0000-0000-000000000001',now()-interval '1 day',null),
 ('14999999-0000-0000-0000-000000000003','04999999-0000-0000-0000-000000000001','staff','24999999-0000-0000-0000-000000000003','94999999-0000-0000-0000-000000000001',now()+interval '7 days',now());

-- ========== 1-B. 공급사 온보딩 (complete_supplier_signup) ==========
set role anon; set request.jwt.claim.role = 'anon'; set request.jwt.claim.sub = '';
insert into results (who,what,expected,result) values
 ('비로그인','온보딩 RPC 호출 → 거부','DENIED: AUTH_REQUIRED', pg_temp.try($q$select public.complete_supplier_signup('신규축산','김신규','01012345678','서울시 어딘가 123','1112223333')$q$));

set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('신규','상호 1글자 → 거부','DENIED: INVALID_BUSINESS_NAME', pg_temp.try($q$select public.complete_supplier_signup('신','김신규','01012345678','서울시 어딘가 123')$q$)),
 ('신규','전화 8자리 → 거부','DENIED: INVALID_PHONE', pg_temp.try($q$select public.complete_supplier_signup('신규축산','김신규','0101234','서울시 어딘가 123')$q$)),
 ('신규','사업자번호 9자리 → 거부','DENIED: INVALID_BUSINESS_NUMBER', pg_temp.try($q$select public.complete_supplier_signup('신규축산','김신규','01012345678','서울시 어딘가 123','123456789')$q$)),
 ('신규','이미 A사가 쓰는 사업자번호 → 거부','DENIED: DUPLICATE_BUSINESS_NUMBER', pg_temp.try($q$select public.complete_supplier_signup('신규축산','김신규','01012345678','서울시 어딘가 123','9490000001')$q$)),
 ('신규','  └ 거부된 시도들로 프로필에 이름이 남지 않았나(빈 문자열)','', pg_temp.val($q$select name from public.profiles where id='94999999-0000-0000-0000-000000000005'$q$)),
 ('신규','정상 온보딩(동의 포함) → 승인 전 상태로 생성','false|true', pg_temp.val($q$select (r->>'is_verified')||'|'||(r->>'business_number_submitted') from public.complete_supplier_signup('신규축산','김신규','010-1234-5678','서울시 어딘가 123','111-22-23333', true) r$q$)),
 ('신규','  └ 동의 시각·이름·전화가 같은 순간에 기록됨','김신규|01012345678|true|true|true', pg_temp.val($q$select name||'|'||phone||'|'||(terms_agreed_at is not null)||'|'||(privacy_agreed_at is not null)||'|'||(marketing_agreed_at is not null) from public.profiles where id='94999999-0000-0000-0000-000000000005'$q$)),
 ('신규','  └ 회사는 승인대기(pending), 국세청 미확인','pending|unchecked|1112223333', pg_temp.val($q$select status||'|'||nts_verification_status||'|'||business_number from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'$q$)),
 ('신규','  └ 조직 owner로 등록됨','owner', pg_temp.val($q$select role::text from public.organization_staff where user_id='94999999-0000-0000-0000-000000000005'$q$)),
 ('신규','  └ 아직 미승인(is_verified=false)','false', pg_temp.val($q$select is_verified::text from public.profiles where id='94999999-0000-0000-0000-000000000005'$q$)),
 ('신규(승인대기)','자기 회사 승인상태를 직접 active로 → 거부(102)','ERROR: PLATFORM_ONLY_COLUMN', pg_temp.rows($q$update public.wholesalers set status='active' where profile_id='94999999-0000-0000-0000-000000000005'$q$)),
 ('신규(승인대기)','국세청 결과를 스스로 match로 → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_nts_verification_result((select id from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'), 'match')$q$)),
 ('신규(승인대기)','승인 플래그를 스스로 → 거부','DENIED: SUPER_ADMIN_REQUIRED', pg_temp.try($q$select public.set_supplier_verification((select id from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'), true)$q$)),
 ('신규(승인대기)','사업자번호 재제출: 개업일 미래 → 거부','DENIED: INVALID_BUSINESS_START_DATE', pg_temp.try($q$select public.submit_supplier_business_number('1112223333', current_date + 1)$q$)),
 ('신규(승인대기)','사업자번호 재제출: 남이 쓰는 번호 → 거부','DENIED: DUPLICATE_BUSINESS_NUMBER', pg_temp.try($q$select public.submit_supplier_business_number('9490000002', current_date - 100)$q$)),
 ('신규(승인대기)','사업자번호 재제출 정상 → 허용','ALLOWED', pg_temp.try($q$select public.submit_supplier_business_number('4445556666', current_date - 100)$q$)),
 ('신규(승인대기)','  └ 번호·개업일 반영, 국세청 상태 unchecked로 리셋','4445556666|unchecked', pg_temp.val($q$select business_number||'|'||nts_verification_status from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'$q$)),
 ('신규(승인대기)','승인 전에도 상품 등록은 DB가 막지 않음(앱 게이트 의존, 정보)','ALLOWED', pg_temp.try($q$insert into public.products (wholesaler_id,name,category,subcategory,origin,base_price,unit,stock_quantity) values ((select id from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'),'미승인 상품','소','안심','국내산',1000,'kg',1)$q$));

-- 다른 종류의 계정은 온보딩 자체가 거절돼야 한다
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000007';
insert into results (who,what,expected,result) values
 ('고객 계정','공급사 온보딩 시도 → 거부','DENIED: NOT_A_SUPPLIER_ACCOUNT', pg_temp.try($q$select public.complete_supplier_signup('식당축산','R사장','01012345678','서울시 어딘가 123')$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000010';
insert into results (who,what,expected,result) values
 ('스태프 채널 계정','공급사 온보딩 시도 → 거부(승인대기 목록에 못 들어감)','DENIED: STAFF_ACCOUNT_CANNOT_ONBOARD', pg_temp.try($q$select public.complete_supplier_signup('내부축산','스태프','01012345678','서울시 어딘가 123')$q$));

-- ========== 1-C. 관리자 승인 게이트 (국세청 결과 기록 → 승인 플래그) ==========
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000008';
insert into results (who,what,expected,result) values
 ('관리자','국세청 결과 잘못된 값 → 거부','DENIED: INVALID_NTS_STATUS', pg_temp.try($q$select public.set_nts_verification_result((select id from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'), 'verified')$q$)),
 ('관리자','국세청 결과 not_found 기록 → 허용','ALLOWED', pg_temp.try($q$select public.set_nts_verification_result((select id from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'), 'not_found')$q$)),
 ('관리자','국세청 결과 match 기록 → 허용','ALLOWED', pg_temp.try($q$select public.set_nts_verification_result((select id from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'), 'match')$q$)),
 ('관리자','승인(status active) → 1행','1', pg_temp.rows($q$update public.wholesalers set status='active' where profile_id='94999999-0000-0000-0000-000000000005'$q$)),
 ('관리자','승인 플래그 전파 → 1명','1', pg_temp.val($q$select (public.set_supplier_verification((select id from public.wholesalers where profile_id='94999999-0000-0000-0000-000000000005'), true))->>'updated'$q$)),
 ('관리자','  └ 신규 계정 is_verified=true','true', pg_temp.val($q$select is_verified::text from public.profiles where id='94999999-0000-0000-0000-000000000005'$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('신규(승인됨)','승인 뒤 사업자번호 재제출 → 거부','DENIED: ALREADY_VERIFIED', pg_temp.try($q$select public.submit_supplier_business_number('7778889999', current_date - 100)$q$));

-- ========== 1-D. 직원 초대 링크 ==========
set role anon; set request.jwt.claim.role = 'anon'; set request.jwt.claim.sub = '';
insert into results (who,what,expected,result) values
 ('비로그인','유효 초대 미리보기 → 회사명만','A축산', pg_temp.val($q$select (public.get_staff_invite_info('24999999-0000-0000-0000-000000000001'))->>'organization_name'$q$)),
 ('비로그인','만료 초대 미리보기 → 없음','<null>', pg_temp.val($q$select (public.get_staff_invite_info('24999999-0000-0000-0000-000000000002'))->>'organization_name'$q$)),
 ('비로그인','초대 수락 → 거부','DENIED: AUTH_REQUIRED', pg_temp.try($q$select public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000001')$q$));

set role authenticated; set request.jwt.claim.role = 'authenticated';
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원','초대 링크 생성 → 거부(owner/manager만)','DENIED: new row violates row-level security policy for table "organization_staff_invites"', pg_temp.try($q$insert into public.organization_staff_invites (organization_id,role,created_by) values ('04999999-0000-0000-0000-000000000001','staff','94999999-0000-0000-0000-000000000003')$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','staff 초대 링크 생성 → 허용','ALLOWED', pg_temp.try($q$insert into public.organization_staff_invites (id,organization_id,role,created_by) values ('14999999-0000-0000-0000-000000000004','04999999-0000-0000-0000-000000000001','staff','94999999-0000-0000-0000-000000000002')$q$)),
 ('A매니저','owner 초대 링크 생성 → 거부(104, 매니저가 사장을 만들 수 없음)','DENIED: OWNER_INVITE_REQUIRES_OWNER', pg_temp.try($q$insert into public.organization_staff_invites (id,organization_id,role,token,created_by) values ('14999999-0000-0000-0000-000000000005','04999999-0000-0000-0000-000000000001','owner','24999999-0000-0000-0000-000000000005','94999999-0000-0000-0000-000000000002')$q$)),
 ('A매니저','기존 staff 초대의 역할을 owner로 변경 → 거부(104)','ERROR: OWNER_INVITE_REQUIRES_OWNER', pg_temp.rows($q$update public.organization_staff_invites set role='owner' where id='14999999-0000-0000-0000-000000000004'$q$)),
 ('A매니저','manager 초대 링크 생성 → 허용','ALLOWED', pg_temp.try($q$insert into public.organization_staff_invites (organization_id,role,created_by) values ('04999999-0000-0000-0000-000000000001','manager','94999999-0000-0000-0000-000000000002')$q$)),
 ('A매니저','B사 초대 링크 생성 → 거부','DENIED', pg_temp.try($q$insert into public.organization_staff_invites (organization_id,role,created_by) values ('04999999-0000-0000-0000-000000000002','staff','94999999-0000-0000-0000-000000000002')$q$)),
 ('A매니저','B사 초대 목록 조회 → 0건','0', pg_temp.val($q$select count(*)::text from public.organization_staff_invites where organization_id='04999999-0000-0000-0000-000000000002'$q$));

set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000007';
insert into results (who,what,expected,result) values
 ('고객 계정','직원 초대 수락 → 거부','DENIED: RETAILER_CANNOT_JOIN_STAFF', pg_temp.try($q$select public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000001')$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000013';
insert into results (who,what,expected,result) values
 ('B사장','A사 직원 초대 수락 → 거부','DENIED', pg_temp.try($q$select public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000001')$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('B직원','A사 직원 초대 수락 → 거부','DENIED: ALREADY_STAFF_ELSEWHERE', pg_temp.try($q$select public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000001')$q$));

set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('초대받은 신규','만료된 초대 수락 → 거부','DENIED: INVALID_OR_EXPIRED_INVITE', pg_temp.try($q$select public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000002')$q$)),
 ('초대받은 신규','취소된 초대 수락 → 거부','DENIED: INVALID_OR_EXPIRED_INVITE', pg_temp.try($q$select public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000003')$q$)),
 ('초대받은 신규','없는 토큰 → 거부','DENIED: INVALID_OR_EXPIRED_INVITE', pg_temp.try($q$select public.claim_organization_staff_invite(gen_random_uuid())$q$)),
 ('초대받은 신규','유효 초대 수락 → A사 staff','staff', pg_temp.val($q$select (public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000001'))->>'role'$q$)),
 ('초대받은 신규','  └ 같은 링크 다시 수락 → 거부','DENIED: ALREADY_STAFF_ELSEWHERE', pg_temp.try($q$select public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000001')$q$)),
 ('초대받은 신규','  └ A사 상품만 보임(A 1 / B 0)','1|0', pg_temp.val($q$select (select count(*) from public.products where wholesaler_id='a4999999-0000-0000-0000-000000000001')||'|'||(select count(*) from public.products where wholesaler_id='a4999999-0000-0000-0000-000000000002')$q$)),
 ('초대받은 신규','  └ A사 주문 보임','1', pg_temp.val($q$select count(*)::text from public.orders where wholesaler_id='a4999999-0000-0000-0000-000000000001'$q$)),
 ('초대받은 신규','  └ 초대 목록은 직원에겐 안 보임','0', pg_temp.val($q$select count(*)::text from public.organization_staff_invites where organization_id='04999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','  └ 초대 사용 횟수 1','1', pg_temp.val($q$select used_count::text from public.organization_staff_invites where id='14999999-0000-0000-0000-000000000001'$q$)),
 ('A사장','owner 초대 링크 생성 → 허용(사장은 가능)','ALLOWED', pg_temp.try($q$insert into public.organization_staff_invites (organization_id,role,created_by) values ('04999999-0000-0000-0000-000000000001','owner','94999999-0000-0000-0000-000000000001')$q$));
-- 같은 링크로 다른 사람도 들어올 수 있나(현재 설계: 만료·취소 전까지 재사용 가능)
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000012';
insert into results (who,what,expected,result) values
 ('두 번째 초대자','같은 링크 수락 → 현재 설계상 허용(단일 사용 아님, 정보)','staff', pg_temp.val($q$select (public.claim_organization_staff_invite('24999999-0000-0000-0000-000000000001'))->>'role'$q$));

-- ========== 1-E. 바이어(식당) 가입 — 미니샵 링크 (claim_shop_access) + 동의 ==========
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000009';
insert into results (who,what,expected,result) values
 ('신규 손님','승인대기 회사 링크로 가입 → 거부(승인 전 영업 불가)','DENIED: INVALID_SHOP_TOKEN', pg_temp.try($q$select public.claim_shop_access('54999999-0000-0000-0000-000000000099')$q$)),
 ('신규 손님','A사 미니샵 링크로 가입 → 거래처 연결','true', pg_temp.val($q$select (public.claim_shop_access('54999999-0000-0000-0000-000000000001'))->>'is_linked'$q$)),
 ('신규 손님','  └ 역할 retailer, 이름은 자리표시자(동의 전 PII 미저장)','retailer|카카오 회원', pg_temp.val($q$select p.role||'|'||r.restaurant_name from public.profiles p join public.retailers r on r.profile_id=p.id where p.id='94999999-0000-0000-0000-000000000009'$q$)),
 ('신규 손님','  └ 동의 전','<null>', pg_temp.val($q$select terms_agreed_at::text from public.profiles where id='94999999-0000-0000-0000-000000000009'$q$)),
 ('신규 손님','동의 기록 → 허용','ALLOWED', pg_temp.try($q$select public.record_buyer_consent(false)$q$)),
 ('신규 손님','  └ 동의 시각 기록, 마케팅은 없음','true|false', pg_temp.val($q$select (terms_agreed_at is not null)||'|'||(marketing_agreed_at is not null) from public.profiles where id='94999999-0000-0000-0000-000000000009'$q$)),
 ('신규 손님','B사 링크로도 가입(여러 공급사 거래) → 허용','true', pg_temp.val($q$select (public.claim_shop_access('54999999-0000-0000-0000-000000000002'))->>'is_linked'$q$)),
 ('신규 손님','공급사 온보딩 시도 → 거부','DENIED: NOT_A_SUPPLIER_ACCOUNT', pg_temp.try($q$select public.complete_supplier_signup('손님축산','이손님','01012345678','서울시 어딘가 123')$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','미니샵 링크로 손님 가입 시도 → 거부(계정 종류 안 섞임)','DENIED: NOT_A_BUYER_ACCOUNT', pg_temp.try($q$select public.claim_shop_access('54999999-0000-0000-0000-000000000002')$q$)),
 ('A사장','바이어 동의 RPC → 거부','DENIED: NOT_A_BUYER_ACCOUNT', pg_temp.try($q$select public.record_buyer_consent(false)$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000008';
insert into results (who,what,expected,result) values
 ('관리자','미니샵 링크로 손님 가입 시도 → 거부','DENIED: NOT_A_BUYER_ACCOUNT', pg_temp.try($q$select public.claim_shop_access('54999999-0000-0000-0000-000000000001')$q$));

-- ========== 1-F. 탈퇴 — 거래 기록은 남고 개인정보만 지워진다 ==========
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000007';
insert into results (who,what,expected,result) values
 ('고객(미수금 50000)','탈퇴 → 현재 설계: 미수금 있어도 허용(정보 — 공급사 탈퇴는 막힘)','ALLOWED', pg_temp.try($q$select public.withdraw_retailer_account()$q$)),
 ('고객','  └ 프로필 익명화','탈퇴한 회원||true', pg_temp.val($q$select name||'|'||phone||'|'||(withdrawn_at is not null) from public.profiles where id='94999999-0000-0000-0000-000000000007'$q$)),
 ('고객','  └ 식당 정보 익명화(사업자번호·주소 제거)','탈퇴한 회원|<null>|', pg_temp.val($q$select restaurant_name||'|'||coalesce(business_number,'<null>')||'|'||delivery_address from public.retailers where id='d4999999-0000-0000-0000-000000000001'$q$)),
 ('고객','  └ 과거 주문·품목은 그대로(이력법 보관)','1|1', pg_temp.val($q$select (select count(*) from public.orders where id='e4999999-0000-0000-0000-000000000001')||'|'||(select count(*) from public.order_items where order_id='e4999999-0000-0000-0000-000000000001')$q$)),
 ('고객','  └ 미수금 기록도 그대로','50000', pg_temp.val($q$select outstanding_balance::int::text from public.wholesaler_retailers where id='b4999999-0000-0000-0000-000000000001'$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원','회사 탈퇴 RPC → 거부(사장만)','DENIED: NOT_A_WHOLESALER_OWNER', pg_temp.try($q$select public.withdraw_wholesaler_account()$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','미수금 남은 상태로 회사 탈퇴 → 거부','DENIED: OUTSTANDING_BALANCE_EXISTS', pg_temp.try($q$select public.withdraw_wholesaler_account()$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000013';
insert into results (who,what,expected,result) values
 ('B사장','회사 탈퇴 → 허용(102 컬럼 보호 트리거가 RPC 내부는 통과하는지 회귀 확인)','ALLOWED', pg_temp.try($q$select public.withdraw_wholesaler_account()$q$)),
 ('B사장','  └ 회사 closed, 상호·사업자번호는 유지','closed|B축산|9490000002', pg_temp.val($q$select status||'|'||business_name||'|'||business_number from public.wholesalers where id='a4999999-0000-0000-0000-000000000002'$q$)),
 ('B사장','  └ 프로필 익명화·승인 해제','탈퇴한 회원|false', pg_temp.val($q$select name||'|'||is_verified from public.profiles where id='94999999-0000-0000-0000-000000000013'$q$)),
 ('B사장','  └ 두 번째 탈퇴 → 거부','DENIED: ALREADY_CLOSED', pg_temp.try($q$select public.withdraw_wholesaler_account()$q$));
set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000009';
insert into results (who,what,expected,result) values
 ('손님','닫힌 B사 링크로 가입 시도 → 거부','DENIED: INVALID_SHOP_TOKEN', pg_temp.try($q$select public.claim_shop_access('54999999-0000-0000-0000-000000000002')$q$));

reset role;
select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
