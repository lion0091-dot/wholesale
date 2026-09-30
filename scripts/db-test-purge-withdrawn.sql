-- 10. 마이그 167 테스트 — 탈퇴 5년 경과 개인정보 파기
-- 실행: (echo "begin;"; cat scripts/db-test-purge-withdrawn.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on
create temp table results (no int generated always as identity, what text, expected text, result text);
insert into auth.users (id,email,created_at) values
 ('96999999-0000-0000-0000-000000000001','w1@p.test',now()),('96999999-0000-0000-0000-000000000002','w2@p.test',now()),
 ('96999999-0000-0000-0000-000000000003','r3@p.test',now());
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('96999999-0000-0000-0000-000000000001','wholesaler','W1','',true,false),
 ('96999999-0000-0000-0000-000000000002','wholesaler','W2','',true,false),
 ('96999999-0000-0000-0000-000000000003','retailer','R3','',false,false)
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
-- W1: 탈퇴 6년 전(파기 대상), W2: 탈퇴 1년 전(유지)
update public.profiles set withdrawn_at = now()-interval '6 years' where id='96999999-0000-0000-0000-000000000001';
update public.profiles set withdrawn_at = now()-interval '1 year' where id='96999999-0000-0000-0000-000000000002';
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,business_address,business_license_path,status,min_order_amount) values
 ('a6999999-0000-0000-0000-000000000001','96999999-0000-0000-0000-000000000001','W1축산','9690000001','대표1','주소1','96999999/lic','closed',0),
 ('a6999999-0000-0000-0000-000000000002','96999999-0000-0000-0000-000000000002','W2축산','9690000002','대표2','주소2','96999999/lic2','closed',0);
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d6999999-0000-0000-0000-000000000003','96999999-0000-0000-0000-000000000003','R3','R','서울');
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address,delivery_notes,ordered_at) values
 ('c6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','d6999999-0000-0000-0000-000000000003','P-1',100,'delivered','서울 강남','문앞', now()-interval '7 years'),
 ('c6999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000002','d6999999-0000-0000-0000-000000000003','P-2',100,'delivered','서울 서초','문앞', now()-interval '1 year');
insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path) values
 ('a6999999-0000-0000-0000-000000000001','a.pdf','a6999999-0000-0000-0000-000000000001/a.pdf');

insert into public.suppliers (id,wholesaler_id,name,name_key,phone,note) values
 ('e6999999-0000-0000-0000-000000000001','a6999999-0000-0000-0000-000000000001','발주처1','발주처1','010-1','메모'),
 ('e6999999-0000-0000-0000-000000000002','a6999999-0000-0000-0000-000000000002','발주처2','발주처2','010-2','메모2');
insert into public.audit_log (table_name,row_id,action,old_data) values
 ('orders','c6999999-0000-0000-0000-000000000001','update','{"delivery_address":"서울 강남"}'),
 ('orders','c6999999-0000-0000-0000-000000000002','update','{"delivery_address":"서울 서초"}');
insert into public.retailer_match_requests (restaurant_name,contact_name,contact_phone,created_at) values
 ('오래된문의','김','010',now()-interval '2 years'),('최근문의','이','010',now()-interval '1 month');
create temp table paths (p text); insert into paths select * from public.purge_expired_withdrawn_personal_data();
insert into results (what,expected,result) values
 ('반환된 사업자등록증 경로','96999999/lic',(select string_agg(p,',') from paths)),
 ('W1(6년) 대표자·주소·경로 파기','(파기됨)/null/null',(select representative_name||'/'||coalesce(business_address,'null')||'/'||coalesce(business_license_path,'null') from public.wholesalers where id='a6999999-0000-0000-0000-000000000001')),
 ('W1 상호·사업자번호 유지','W1축산/9690000001',(select business_name||'/'||business_number from public.wholesalers where id='a6999999-0000-0000-0000-000000000001')),
 ('W2(1년) 유지','대표2/주소2',(select representative_name||'/'||business_address from public.wholesalers where id='a6999999-0000-0000-0000-000000000002')),
 ('W1 주문 배송지 파기, 금액·번호 유지','(파기됨)/null/100/P-1',(select delivery_address||'/'||coalesce(delivery_notes,'null')||'/'||total_amount::int||'/'||order_number from public.orders where id='c6999999-0000-0000-0000-000000000001')),
 ('W2 주문 유지','서울 서초/문앞',(select delivery_address||'/'||delivery_notes from public.orders where id='c6999999-0000-0000-0000-000000000002')),
 ('명세서 파일 유지','1',(select count(*)::text from public.supplier_statement_files where wholesaler_id='a6999999-0000-0000-0000-000000000001'));
create temp table paths2 (p text); insert into paths2 select * from public.purge_expired_withdrawn_personal_data();
insert into results (what,expected,result) values ('재실행 멱등(반환 0건)','0',(select count(*)::text from paths2));
grant all on results to authenticated; set role authenticated;
create function pg_temp.try(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return 'ALLOWED'; exception when others then return 'DENIED'; end $$;
insert into results (what,expected,result) values ('일반 사용자 호출 거부','DENIED',pg_temp.try($q$select * from public.purge_expired_withdrawn_personal_data()$q$));
reset role;
insert into results (what,expected,result) values
 ('W1 발주처 전화·메모 파기, 상호 유지','null/null/발주처1',(select coalesce(phone,'null')||'/'||coalesce(note,'null')||'/'||name from public.suppliers where id='e6999999-0000-0000-0000-000000000001')),
 ('W2(유지) 발주처 그대로','010-2/메모2',(select phone||'/'||note from public.suppliers where id='e6999999-0000-0000-0000-000000000002'));
insert into results (what,expected,result) values
 ('W1 주문의 변경이력 복사본 파기(자체 UPDATE가 남긴 것 포함)','0',(select count(*)::text from public.audit_log where table_name='orders' and row_id='c6999999-0000-0000-0000-000000000001')),
 ('W2 주문 변경이력은 유지(시드 1+주문 생성 시 자동 1)','2',(select count(*)::text from public.audit_log where table_name='orders' and row_id='c6999999-0000-0000-0000-000000000002')),
 ('입점 문의: 2년 전 삭제, 1개월 전 유지','0/1',(select count(*) filter (where restaurant_name='오래된문의')::text||'/'||count(*) filter (where restaurant_name='최근문의')::text from public.retailer_match_requests));
-- 168: 식별정보 정리 + 고객 탈퇴 시 상호 유지
insert into auth.identities (provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
 values ('k123','96999999-0000-0000-0000-000000000002','{"sub":"k123","email":"x@k.com","name":"닉"}','kakao',now(),now(),now());
insert into results (what,expected,result) values
 ('탈퇴 미처리 계정은 정리 안 함(W3)','0',(select public.scrub_withdrawn_login_identity('96999999-0000-0000-0000-000000000003'))::text);
create temp table sc (n int); insert into sc select public.scrub_withdrawn_login_identity('96999999-0000-0000-0000-000000000002');
insert into results (what,expected,result) values
 ('탈퇴 계정 식별정보 정리(1행), sub만 남음','1/{"sub": "k123"}',(select n::text from sc)||'/'||(select identity_data::text from auth.identities where provider_id='k123'));
select no, what, expected, result, case when result=expected then 'PASS' else 'FAIL' end v from results order by no;
