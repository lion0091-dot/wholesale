-- 9. 마이그 166 테스트 — 소매 미완료 계정 정리 대상/삭제 + 명세서 파일 FK RESTRICT
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-stale-retailers.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ALLOWED';
exception when others then return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

create temp table results (no int generated always as identity, who text, what text, expected text, result text);
grant all on results to authenticated, anon, service_role;

-- 21 이탈 소매(거래 흔적 없음) → 대상 / 22 초대장 사용 기록 있음 → 제외 / 23 최근 로그인 → 제외
-- 24 맞춤단가 아닌 동의 완료 → 제외 / 30 업체(파일 FK 테스트용)
insert into auth.users (id,email,created_at,last_sign_in_at) values
 ('95999999-0000-0000-0000-000000000021','r21@stale.test', now()-interval '40 days', null),
 ('95999999-0000-0000-0000-000000000022','r22@stale.test', now()-interval '40 days', null),
 ('95999999-0000-0000-0000-000000000023','r23@stale.test', now()-interval '40 days', now()-interval '3 days'),
 ('95999999-0000-0000-0000-000000000024','r24@stale.test', now()-interval '40 days', null),
 ('95999999-0000-0000-0000-000000000025','r25@stale.test', now()-interval '40 days', null),
 ('95999999-0000-0000-0000-000000000030','w30@stale.test', now()-interval '40 days', null);
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('95999999-0000-0000-0000-000000000021','retailer','R21','',false,false),
 ('95999999-0000-0000-0000-000000000022','retailer','R22','',false,false),
 ('95999999-0000-0000-0000-000000000023','retailer','R23','',false,false),
 ('95999999-0000-0000-0000-000000000024','retailer','R24','',false,false),
 ('95999999-0000-0000-0000-000000000025','retailer','R25','',false,false),
 ('95999999-0000-0000-0000-000000000030','wholesaler','W30','',true,false)
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
update public.profiles set terms_agreed_at = now(), privacy_agreed_at = now() where id = '95999999-0000-0000-0000-000000000024';
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,min_order_amount) values
 ('a5999999-0000-0000-0000-000000000030','95999999-0000-0000-0000-000000000030','W축산','9590000030','W','pending',0);
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d5999999-0000-0000-0000-000000000021','95999999-0000-0000-0000-000000000021','R21','R','서울'),
 ('d5999999-0000-0000-0000-000000000022','95999999-0000-0000-0000-000000000022','R22','R','서울'),
 ('d5999999-0000-0000-0000-000000000023','95999999-0000-0000-0000-000000000023','R23','R','서울'),
 ('d5999999-0000-0000-0000-000000000024','95999999-0000-0000-0000-000000000024','R24','R','서울'),
 ('d5999999-0000-0000-0000-000000000025','95999999-0000-0000-0000-000000000025','R25','R','서울');
-- 21: 초대 없이 들어온 승인 대기 연결(삭제 대상) / 25: 공급사가 이미 승인한 연결(173: 제외)
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status) values
 ('a5999999-0000-0000-0000-000000000030','d5999999-0000-0000-0000-000000000021','pending_review'),
 ('a5999999-0000-0000-0000-000000000030','d5999999-0000-0000-0000-000000000025','active');
insert into public.retailer_invites (wholesaler_id,phone,customer_name,expires_at,consumed_at,consumed_retailer_id) values
 ('a5999999-0000-0000-0000-000000000030','01000000001','손님', now()+interval '10 days', now(), 'd5999999-0000-0000-0000-000000000022');
insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path) values
 ('a5999999-0000-0000-0000-000000000030','a.pdf','a5999999-0000-0000-0000-000000000030/a.pdf');

set role service_role;
insert into results (who,what,expected,result)
select '서버','대상 목록(21만: 초대사용22·최근로그인23·동의완료24·승인된 연결25 제외)','95999999-0000-0000-0000-000000000021',
       coalesce((select string_agg(user_id::text, ',' order by user_id::text) from public.list_stale_unconsented_retail_accounts() where user_id::text like '95999999%'), '<none>');
insert into results (who,what,expected,result)
select '서버','승인된 연결이 있는 고객(25) 삭제 시도 → 0행, 행·연결 유지','0/1/1',
       public.delete_stale_retailer_rows('95999999-0000-0000-0000-000000000025')::text || '/' ||
       (select count(*)::text from public.retailers where id='d5999999-0000-0000-0000-000000000025') || '/' ||
       (select count(*)::text from public.wholesaler_retailers where retailer_id='d5999999-0000-0000-0000-000000000025');
insert into results (who,what,expected,result)
select '서버','제외 대상(22) 삭제 시도 → 0행, 행 유지','0/1',
       public.delete_stale_retailer_rows('95999999-0000-0000-0000-000000000022')::text || '/' ||
       (select count(*)::text from public.retailers where id='d5999999-0000-0000-0000-000000000022');
create temp table del21 (n int); grant all on del21 to service_role;
insert into del21 select public.delete_stale_retailer_rows('95999999-0000-0000-0000-000000000021');
insert into results (who,what,expected,result)
select '서버','대상(21) 삭제 → 1행, retailers·자동연결 삭제','1/0/0',
       (select n::text from del21) || '/' ||
       (select count(*)::text from public.retailers where id='d5999999-0000-0000-0000-000000000021') || '/' ||
       (select count(*)::text from public.wholesaler_retailers where retailer_id='d5999999-0000-0000-0000-000000000021');
insert into results (who,what,expected,result) values
 ('서버','명세서 파일이 있는 업체 행 직접 삭제 → 거부(RESTRICT)','DENIED', pg_temp.try($q$delete from public.wholesalers where id='a5999999-0000-0000-0000-000000000030'$q$));
reset role;

set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '95999999-0000-0000-0000-000000000023';
insert into results (who,what,expected,result) values
 ('로그인 사용자','대상 조회 시도 → 거부','DENIED', pg_temp.try($q$select * from public.list_stale_unconsented_retail_accounts()$q$)),
 ('로그인 사용자','삭제 함수 호출 → 거부','DENIED', pg_temp.try($q$select public.delete_stale_retailer_rows('95999999-0000-0000-0000-000000000022')$q$));
reset role;

select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
