-- 8. 가입 미완료 계정 자동 정리 대상 조회(165) 테스트 — list_stale_unconsented_accounts()
--    실제 삭제(Auth Admin API)는 크론 라우트가 하며 여기서 다루지 않는다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-stale-accounts.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
    execute p_sql;
    return 'ALLOWED';
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- ========== 시드 (접두어 94) — 전부 동의 없음(terms/privacy NULL)이 기본 ==========
-- 01 오래된 이탈자(40일 전 가입, 로그인 기록 없음) → 대상
-- 02 40일 전 가입했지만 5일 전에 다시 로그인 → 제외(진행 중)
-- 03 10일 전 가입 → 제외(아직 30일 안 지남)
-- 04 40일 전 가입, 동의 완료 → 제외
-- 05 40일 전, 업체(wholesalers) 있음 → 제외
-- 06 40일 전, 고객(retailers) 있음 → 제외
-- 07 40일 전, 조직 직원 → 제외
-- 08 40일 전, super_admin → 제외
-- 09 40일 전, 탈퇴 처리됨 → 제외
-- 10 40일 전, 마지막 로그인 35일 전 → 대상
-- 11 40일 전, 초대장 발부 기록 있음 → 제외
insert into auth.users (id,email,created_at,last_sign_in_at) values
 ('94999999-0000-0000-0000-000000000001','s1@stale.test', now()-interval '40 days', null),
 ('94999999-0000-0000-0000-000000000002','s2@stale.test', now()-interval '40 days', now()-interval '5 days'),
 ('94999999-0000-0000-0000-000000000003','s3@stale.test', now()-interval '10 days', null),
 ('94999999-0000-0000-0000-000000000004','s4@stale.test', now()-interval '40 days', null),
 ('94999999-0000-0000-0000-000000000005','s5@stale.test', now()-interval '40 days', null),
 ('94999999-0000-0000-0000-000000000006','s6@stale.test', now()-interval '40 days', null),
 ('94999999-0000-0000-0000-000000000007','s7@stale.test', now()-interval '40 days', null),
 ('94999999-0000-0000-0000-000000000008','s8@stale.test', now()-interval '40 days', null),
 ('94999999-0000-0000-0000-000000000009','s9@stale.test', now()-interval '40 days', null),
 ('94999999-0000-0000-0000-000000000010','s10@stale.test', now()-interval '40 days', now()-interval '35 days'),
 ('94999999-0000-0000-0000-000000000011','s11@stale.test', now()-interval '40 days', null);
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('94999999-0000-0000-0000-000000000001','wholesaler','A','',false,false),
 ('94999999-0000-0000-0000-000000000002','wholesaler','B','',false,false),
 ('94999999-0000-0000-0000-000000000003','wholesaler','C','',false,false),
 ('94999999-0000-0000-0000-000000000004','wholesaler','D','',true,false),
 ('94999999-0000-0000-0000-000000000005','wholesaler','E','',true,false),
 ('94999999-0000-0000-0000-000000000006','retailer','F','',false,false),
 ('94999999-0000-0000-0000-000000000007','wholesaler','G','',false,false),
 ('94999999-0000-0000-0000-000000000008','super_admin','H','',false,true),
 ('94999999-0000-0000-0000-000000000009','wholesaler','I','',false,false),
 ('94999999-0000-0000-0000-000000000010','wholesaler','J','',false,false),
 ('94999999-0000-0000-0000-000000000011','wholesaler','K','',true,false)
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
update public.profiles set terms_agreed_at = now(), privacy_agreed_at = now() where id = '94999999-0000-0000-0000-000000000004';
update public.profiles set withdrawn_at = now() where id = '94999999-0000-0000-0000-000000000009';
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,min_order_amount) values
 ('a4999999-0000-0000-0000-000000000005','94999999-0000-0000-0000-000000000005','E축산','9490000005','E','pending',0),
 ('a4999999-0000-0000-0000-000000000011','94999999-0000-0000-0000-000000000011','K축산','9490000011','K','pending',0);
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('04999999-0000-0000-0000-000000000005','a4999999-0000-0000-0000-000000000005','E축산','9490000005');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d4999999-0000-0000-0000-000000000006','94999999-0000-0000-0000-000000000006','F식당','F','서울');
insert into public.organization_staff (organization_id,user_id,role) values
 ('04999999-0000-0000-0000-000000000005','94999999-0000-0000-0000-000000000007','staff');
insert into public.retailer_invites (wholesaler_id,phone,customer_name,created_by,expires_at) values
 ('a4999999-0000-0000-0000-000000000011','01000000000','손님','94999999-0000-0000-0000-000000000011', now()+interval '10 days');

-- ========== 8-A. 서버(service_role): 대상 판정 ==========
set role service_role;
insert into results (who,what,expected,result)
select '서버', '대상 계정 목록(01, 10만)', '94999999-0000-0000-0000-000000000001,94999999-0000-0000-0000-000000000010',
       coalesce((select string_agg(user_id::text, ',' order by user_id::text) from public.list_stale_unconsented_accounts() where user_id::text like '94999999%'), '<none>');
insert into results (who,what,expected,result)
select '서버', '최근 로그인(02)·가입 10일(03)·동의 완료(04)·업체(05)·고객(06)·직원(07)·슈퍼관리자(08)·탈퇴(09)·초대 발부(11) 제외', '0',
       (select count(*)::text from public.list_stale_unconsented_accounts() where user_id::text like '94999999%' and user_id::text not in ('94999999-0000-0000-0000-000000000001','94999999-0000-0000-0000-000000000010'));
reset role;

-- ========== 8-B. 일반 세션은 호출 불가 ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '94999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('로그인 사용자','계정 정리 대상 조회 시도 → 거부(계정 목록 노출 방지)','DENIED', pg_temp.try($q$select * from public.list_stale_unconsented_accounts()$q$));
reset role; set role anon; set request.jwt.claim.role = 'anon'; set request.jwt.claim.sub = '';
insert into results (who,what,expected,result) values
 ('비로그인','계정 정리 대상 조회 시도 → 거부','DENIED', pg_temp.try($q$select * from public.list_stale_unconsented_accounts()$q$));
reset role;

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
