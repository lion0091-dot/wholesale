-- 7. 알림톡 자격정보(비즈뿌리오 계정·암호화 비밀번호·발신프로필키·템플릿 코드) 노출·수정 권한 테스트
--    같은 구조인 토스 시크릿키(pg_secret_key_encrypted)도 함께 본다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-alimtalk-credentials.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
--
-- expected 칸은 "설계상 이래야 한다"(공급사 자격정보는 owner/manager만, 바이어·타사·비로그인은 못 봄).
-- FAIL이 나오면 그 줄이 곧 발견 사항이다. [정보] 표시는 현재 동작을 그대로 적은 것.
\set ON_ERROR_STOP on

-- 값이 조회되면 LEAK, 오류이거나 행이 안 보이면 HIDDEN
create function pg_temp.leak(p_sql text) returns text language plpgsql as $$
declare v text;
begin
    execute p_sql into v;
    return case when v is null then 'HIDDEN' else 'LEAK' end;
exception when others then
    return 'HIDDEN';
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

-- ========== 시드 (이 스크립트 전용 ID 접두어 91) ==========
insert into auth.users (id,email) values
 ('91999999-0000-0000-0000-000000000001','owner-a@alim.test'),
 ('91999999-0000-0000-0000-000000000002','owner-b@alim.test'),
 ('91999999-0000-0000-0000-000000000003','retailer-linked@alim.test'),
 ('91999999-0000-0000-0000-000000000004','staff-a@alim.test'),
 ('91999999-0000-0000-0000-000000000005','manager-a@alim.test'),
 ('91999999-0000-0000-0000-000000000006','retailer-unlinked@alim.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('91999999-0000-0000-0000-000000000001','wholesaler','A사장','010'),
 ('91999999-0000-0000-0000-000000000002','wholesaler','B사장','010'),
 ('91999999-0000-0000-0000-000000000003','retailer','연결식당','010'),
 ('91999999-0000-0000-0000-000000000004','wholesaler','A직원','010'),
 ('91999999-0000-0000-0000-000000000005','wholesaler','A매니저','010'),
 ('91999999-0000-0000-0000-000000000006','retailer','미연결식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,subscription_status,
                                alimtalk_provider,alimtalk_account,alimtalk_password_encrypted,alimtalk_sender_key,alimtalk_sender_phone,alimtalk_template_codes,
                                pg_secret_key_encrypted) values
 ('a9199999-0000-0000-0000-000000000001','91999999-0000-0000-0000-000000000001','A축산','9190000001','A','active','trial',
  'bizppurio','acct-a','CIPHER-A','senderkey-a','01000000001','{"orderNew":"TPL_A"}','PGCIPHER-A'),
 ('a9199999-0000-0000-0000-000000000002','91999999-0000-0000-0000-000000000002','B축산','9190000002','B','active','trial',
  'bizppurio','acct-b','CIPHER-B','senderkey-b','01000000002','{"orderNew":"TPL_B"}','PGCIPHER-B');
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('09199999-0000-0000-0000-000000000001','a9199999-0000-0000-0000-000000000001','A축산','9190000001'),
 ('09199999-0000-0000-0000-000000000002','a9199999-0000-0000-0000-000000000002','B축산','9190000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('09199999-0000-0000-0000-000000000001','91999999-0000-0000-0000-000000000004','staff'),
 ('09199999-0000-0000-0000-000000000001','91999999-0000-0000-0000-000000000005','manager');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d9199999-0000-0000-0000-000000000001','91999999-0000-0000-0000-000000000003','연결식당','사장','서울'),
 ('d9199999-0000-0000-0000-000000000002','91999999-0000-0000-0000-000000000006','미연결식당','사장','부산');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status,credit_limit,outstanding_balance) values
 ('a9199999-0000-0000-0000-000000000001','d9199999-0000-0000-0000-000000000001','active',0,0);

-- ========== 1. 조회 노출: 자기 공급사(A)의 자격정보 컬럼을 누가 읽을 수 있나 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('연결 거래처','A사 알림톡 암호화 비밀번호 조회','HIDDEN', pg_temp.leak($q$select alimtalk_password_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('연결 거래처','A사 알림톡 계정 조회','HIDDEN', pg_temp.leak($q$select alimtalk_account from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('연결 거래처','A사 발신프로필키 조회','HIDDEN', pg_temp.leak($q$select alimtalk_sender_key from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('연결 거래처','A사 템플릿 코드 조회','HIDDEN', pg_temp.leak($q$select alimtalk_template_codes::text from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('연결 거래처','A사 토스 시크릿키(암호문) 조회','HIDDEN', pg_temp.leak($q$select pg_secret_key_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('연결 거래처','A사 상호(공개 정보) 조회','LEAK', pg_temp.leak($q$select business_name from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('연결 거래처','select * 로 A사 행 통째 조회 시 비밀번호 컬럼 포함 여부','HIDDEN', pg_temp.leak($q$select (w.alimtalk_password_encrypted) from (select * from public.wholesalers where id='a9199999-0000-0000-0000-000000000001') w$q$));

set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000006';
insert into results (who,what,expected,result) values
 ('미연결 거래처','A사 알림톡 암호화 비밀번호 조회','HIDDEN', pg_temp.leak($q$select alimtalk_password_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('미연결 거래처','A사 상호 조회(연결 안 됐으니 행 자체가 안 보임)','HIDDEN', pg_temp.leak($q$select business_name from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$));

set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('A직원(staff)','A사 알림톡 암호화 비밀번호 조회','HIDDEN', pg_temp.leak($q$select alimtalk_password_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('A직원(staff)','A사 알림톡 계정 조회','HIDDEN', pg_temp.leak($q$select alimtalk_account from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('A직원(staff)','A사 토스 시크릿키(암호문) 조회','HIDDEN', pg_temp.leak($q$select pg_secret_key_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('A직원(staff)','B사 알림톡 암호화 비밀번호 조회','HIDDEN', pg_temp.leak($q$select alimtalk_password_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000002'$q$));

set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('B사장(타 공급사)','A사 알림톡 암호화 비밀번호 조회','HIDDEN', pg_temp.leak($q$select alimtalk_password_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('B사장(타 공급사)','A사 토스 시크릿키(암호문) 조회','HIDDEN', pg_temp.leak($q$select pg_secret_key_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$));

set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A매니저','A사 알림톡 암호화 비밀번호 조회','HIDDEN', pg_temp.leak($q$select alimtalk_password_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$));

set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','자기 알림톡 암호화 비밀번호도 세션으로는 조회 불가(설정 화면은 서버가 service_role로 읽음)','HIDDEN', pg_temp.leak($q$select alimtalk_password_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$));

reset role;
set role anon; reset request.jwt.claim.sub; reset request.jwt.claim.role;
insert into results (who,what,expected,result) values
 ('비로그인','A사 알림톡 암호화 비밀번호 조회','HIDDEN', pg_temp.leak($q$select alimtalk_password_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('비로그인','A사 토스 시크릿키(암호문) 조회','HIDDEN', pg_temp.leak($q$select pg_secret_key_encrypted from public.wholesalers where id='a9199999-0000-0000-0000-000000000001'$q$));
reset role;

-- ========== 2. 수정 권한: 앱은 owner/manager만 저장 허용 — DB는? ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','자기 알림톡 계정 수정 → 1행','1', pg_temp.rows($q$update public.wholesalers set alimtalk_account='acct-a2' where id='a9199999-0000-0000-0000-000000000001'$q$)),
 ('A사장','B사 알림톡 계정 수정 → 0행','0', pg_temp.rows($q$update public.wholesalers set alimtalk_account='hack' where id='a9199999-0000-0000-0000-000000000002'$q$));

set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('A매니저','세션 직접 UPDATE는 사장만 통과 → 0행 (매니저 저장은 서버 액션이 owner/manager 확인 후 service_role로 처리)','0', pg_temp.rows($q$update public.wholesalers set alimtalk_account='acct-mgr' where id='a9199999-0000-0000-0000-000000000001'$q$));

set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('A직원(staff)','알림톡 설정 수정(앱은 staff 불가) → 0행','0', pg_temp.rows($q$update public.wholesalers set alimtalk_account='hack', alimtalk_sender_phone='01099999999' where id='a9199999-0000-0000-0000-000000000001'$q$));

set request.jwt.claim.sub = '91999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('연결 거래처','A사 알림톡 설정 수정 → 0행','0', pg_temp.rows($q$update public.wholesalers set alimtalk_sender_phone='01099999999' where id='a9199999-0000-0000-0000-000000000001'$q$));
reset role;

-- ========== 3. 컬럼 추가 누락 감시 ==========
-- 110은 "숨길 컬럼 외 전부 읽기 허용"을 시점 기준으로 부여했다. 이후 wholesalers에 컬럼이 추가됐는데
-- GRANT SELECT를 안 줬다면 여기서 잡힌다(세션에서 그 컬럼을 읽으면 권한 오류가 난다).
insert into results (who,what,expected,result)
select 'authenticated','읽기 권한 없는 공개 컬럼: ' || column_name, 'granted', 'MISSING GRANT'
  from information_schema.columns
 where table_schema='public' and table_name='wholesalers'
   and column_name not like 'alimtalk\_%' and column_name <> 'pg_secret_key_encrypted'
   and not has_column_privilege('authenticated','public.wholesalers',column_name,'SELECT');
insert into results (who,what,expected,result)
values ('authenticated','숨김 컬럼 7개 전부 SELECT 권한 없음','7',
        (select count(*)::text from information_schema.columns
          where table_schema='public' and table_name='wholesalers'
            and (column_name like 'alimtalk\_%' or column_name = 'pg_secret_key_encrypted')
            and not has_column_privilege('authenticated','public.wholesalers',column_name,'SELECT')
            and not has_column_privilege('anon','public.wholesalers',column_name,'SELECT')));

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected) as pass,
       count(*) filter (where result <> expected) as fail
  from results;
select '--- 시도 뒤 실제 값: alimtalk_account=acct-a2 (사장 수정분만, 매니저 수정이 먹었다면 acct-mgr) ---' as t;
select id, alimtalk_account, alimtalk_sender_phone from public.wholesalers where id::text like 'a9199999%' order by id;
