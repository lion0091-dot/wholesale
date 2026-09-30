-- 7. 공급처 명세서 파일 보관함(164) 통합테스트 — DB 레벨(권한·격리·삭제 불가·숨김만 가능)
--    파일 업로드 자체(Storage)와 화면은 여기서 다루지 않는다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-statement-files.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
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

-- ========== 시드 (접두어 93) ==========
insert into auth.users (id,email) values
 ('93999999-0000-0000-0000-000000000001','owner-a@stmt.test'),
 ('93999999-0000-0000-0000-000000000002','manager-a@stmt.test'),
 ('93999999-0000-0000-0000-000000000003','staff-a@stmt.test'),
 ('93999999-0000-0000-0000-000000000004','retailer-r@stmt.test'),
 ('93999999-0000-0000-0000-000000000005','owner-b@stmt.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('93999999-0000-0000-0000-000000000001','wholesaler','A사장','010',true,true),
 ('93999999-0000-0000-0000-000000000002','wholesaler','A매니저','010',true,true),
 ('93999999-0000-0000-0000-000000000003','wholesaler','A직원','010',true,true),
 ('93999999-0000-0000-0000-000000000004','retailer','식당R','010',false,false),
 ('93999999-0000-0000-0000-000000000005','wholesaler','B사장','010',true,true)
 on conflict (id) do update set role=excluded.role, name=excluded.name;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,min_order_amount) values
 ('a3999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000001','A축산','9390000001','A','active',0),
 ('a3999999-0000-0000-0000-000000000002','93999999-0000-0000-0000-000000000005','B축산','9390000002','B','active',0);
insert into public.organizations (id,wholesaler_id,name,business_number) values
 ('03999999-0000-0000-0000-000000000001','a3999999-0000-0000-0000-000000000001','A축산','9390000001'),
 ('03999999-0000-0000-0000-000000000002','a3999999-0000-0000-0000-000000000002','B축산','9390000002');
insert into public.organization_staff (organization_id,user_id,role) values
 ('03999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000001','owner'),
 ('03999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000002','manager'),
 ('03999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000003','staff'),
 ('03999999-0000-0000-0000-000000000002','93999999-0000-0000-0000-000000000005','owner');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d3999999-0000-0000-0000-000000000001','93999999-0000-0000-0000-000000000004','식당R','사장','서울');
insert into public.suppliers (id,wholesaler_id,name) values
 ('b3999999-0000-0000-0000-000000000001','a3999999-0000-0000-0000-000000000001','A의 공급처'),
 ('b3999999-0000-0000-0000-000000000002','a3999999-0000-0000-0000-000000000002','B의 공급처');
-- 서버(service_role) 시드: 다른 사람 화면 테스트용 B사 파일 1건
insert into public.supplier_statement_files (id,wholesaler_id,file_name,storage_path,uploaded_by) values
 ('c3999999-0000-0000-0000-0000000000b1','a3999999-0000-0000-0000-000000000002','b.xlsx','a3999999-0000-0000-0000-000000000002/b1','93999999-0000-0000-0000-000000000005');

-- ========== 7-A. 공급사 사장(A) ==========
set role authenticated; set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000001';
insert into results (who,what,expected,result) values
 ('A사장','명세서 파일 등록(거래처·날짜·메모 포함) → 허용','ALLOWED', pg_temp.try($q$insert into public.supplier_statement_files (id,wholesaler_id,supplier_id,statement_date,memo,file_name,mime_type,size_bytes,storage_path,uploaded_by) values ('c3999999-0000-0000-0000-0000000000a1','a3999999-0000-0000-0000-000000000001','b3999999-0000-0000-0000-000000000001','2026-04-29','4/29 납품','횡성 명세서.xls','application/vnd.ms-excel',82944,'a3999999-0000-0000-0000-000000000001/a1','93999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','거래처·날짜 없이도 등록 허용(선택 항목)','ALLOWED', pg_temp.try($q$insert into public.supplier_statement_files (id,wholesaler_id,file_name,storage_path,uploaded_by) values ('c3999999-0000-0000-0000-0000000000a2','a3999999-0000-0000-0000-000000000001','사진.jpg','a3999999-0000-0000-0000-000000000001/a2','93999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','올린 사람을 남의 이름으로 기록 → 거부','DENIED', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path,uploaded_by) values ('a3999999-0000-0000-0000-000000000001','x','a3999999-0000-0000-0000-000000000001/x1','93999999-0000-0000-0000-000000000002')$q$)),
 ('A사장','타사(B) 명의로 등록 → 거부','DENIED', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path,uploaded_by) values ('a3999999-0000-0000-0000-000000000002','x','a3999999-0000-0000-0000-000000000002/x2','93999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','다른 업체 폴더 경로로 등록 → 거부(경로 CHECK)','DENIED', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path,uploaded_by) values ('a3999999-0000-0000-0000-000000000001','x','a3999999-0000-0000-0000-000000000002/x3','93999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','타사(B)의 거래처를 붙여서 등록 → 거부','DENIED: SUPPLIER_TENANT_MISMATCH', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,supplier_id,file_name,storage_path,uploaded_by) values ('a3999999-0000-0000-0000-000000000001','b3999999-0000-0000-0000-000000000002','x','a3999999-0000-0000-0000-000000000001/x4','93999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','같은 저장 경로 두 번 → 거부(유니크)','DENIED', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path,uploaded_by) values ('a3999999-0000-0000-0000-000000000001','dup','a3999999-0000-0000-0000-000000000001/a1','93999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','파일명 빈 값 → 거부','DENIED', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path,uploaded_by) values ('a3999999-0000-0000-0000-000000000001','','a3999999-0000-0000-0000-000000000001/x5','93999999-0000-0000-0000-000000000001')$q$)),
 ('A사장','숨김 상태로 등록 시도 → 숨김이 무시되고 보이는 상태로 저장','ALLOWED|<null>', pg_temp.try($q$insert into public.supplier_statement_files (id,wholesaler_id,file_name,storage_path,uploaded_by,hidden_at) values ('c3999999-0000-0000-0000-0000000000a3','a3999999-0000-0000-0000-000000000001','h.pdf','a3999999-0000-0000-0000-000000000001/a3','93999999-0000-0000-0000-000000000001',now())$q$)||'|'||pg_temp.val($q$select hidden_at::text from public.supplier_statement_files where id='c3999999-0000-0000-0000-0000000000a3'$q$)),
 ('A사장','자사 파일 3건만 조회(타사 B 파일은 안 보임)','3', pg_temp.val($q$select count(*)::text from public.supplier_statement_files$q$)),
 ('A사장','메모 수정 → 거부(숨김 외 수정 불가)','DENIED: STATEMENT_FILE_IMMUTABLE', pg_temp.try($q$update public.supplier_statement_files set memo='바꿈' where id='c3999999-0000-0000-0000-0000000000a1'$q$)),
 ('A사장','파일명·경로·거래처 수정 → 거부','DENIED: STATEMENT_FILE_IMMUTABLE', pg_temp.try($q$update public.supplier_statement_files set file_name='바꿈.xls' where id='c3999999-0000-0000-0000-0000000000a1'$q$)),
 ('A사장','삭제 시도 → 0행(삭제 정책 없음)','0', pg_temp.rows($q$delete from public.supplier_statement_files where id='c3999999-0000-0000-0000-0000000000a1'$q$)),
 ('A사장','타사(B) 파일 숨김 시도 → 0행','0', pg_temp.rows($q$update public.supplier_statement_files set hidden_at=now(), hidden_by='93999999-0000-0000-0000-000000000001' where id='c3999999-0000-0000-0000-0000000000b1'$q$)),
 ('A사장','자사 파일 숨김 → 1행','1', pg_temp.rows($q$update public.supplier_statement_files set hidden_at=now(), hidden_by='93999999-0000-0000-0000-000000000001' where id='c3999999-0000-0000-0000-0000000000a3'$q$)),
 ('A사장','숨김 해제 시도 → 거부','DENIED: STATEMENT_FILE_IMMUTABLE', pg_temp.try($q$update public.supplier_statement_files set hidden_at=null, hidden_by=null where id='c3999999-0000-0000-0000-0000000000a3'$q$)),
 ('A사장','이미 숨긴 파일의 숨김 시각 바꾸기 → 거부','DENIED: STATEMENT_FILE_IMMUTABLE', pg_temp.try($q$update public.supplier_statement_files set hidden_at=now()+interval '1 day' where id='c3999999-0000-0000-0000-0000000000a3'$q$));

-- ========== 7-B. 매니저·직원 ==========
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000002';
insert into results (who,what,expected,result) values
 ('A매니저','매니저 숨김 → 1행','1', pg_temp.rows($q$update public.supplier_statement_files set hidden_at=now(), hidden_by='93999999-0000-0000-0000-000000000002' where id='c3999999-0000-0000-0000-0000000000a2'$q$)),
 ('A매니저','매니저도 삭제 → 0행','0', pg_temp.rows($q$delete from public.supplier_statement_files where id='c3999999-0000-0000-0000-0000000000a1'$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000003';
insert into results (who,what,expected,result) values
 ('A직원','직원도 파일 등록 → 허용(현장에서 받은 명세서를 바로 올림)','ALLOWED', pg_temp.try($q$insert into public.supplier_statement_files (id,wholesaler_id,file_name,storage_path,uploaded_by) values ('c3999999-0000-0000-0000-0000000000a4','a3999999-0000-0000-0000-000000000001','직원.pdf','a3999999-0000-0000-0000-000000000001/a4','93999999-0000-0000-0000-000000000003')$q$)),
 ('A직원','직원도 목록 조회 → 4건(숨김 포함, 화면이 숨김을 거른다)','4', pg_temp.val($q$select count(*)::text from public.supplier_statement_files$q$)),
 ('A직원','직원의 숨김 시도 → 0행(owner·manager만)','0', pg_temp.rows($q$update public.supplier_statement_files set hidden_at=now(), hidden_by='93999999-0000-0000-0000-000000000003' where id='c3999999-0000-0000-0000-0000000000a4'$q$));

-- ========== 7-C. 타사·고객·비로그인 ==========
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000005';
insert into results (who,what,expected,result) values
 ('B사장','B사장은 자사 파일 1건만 조회(A사 4건 안 보임)','1', pg_temp.val($q$select count(*)::text from public.supplier_statement_files$q$)),
 ('B사장','A사 명의로 등록 → 거부','DENIED', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path,uploaded_by) values ('a3999999-0000-0000-0000-000000000001','x','a3999999-0000-0000-0000-000000000001/y1','93999999-0000-0000-0000-000000000005')$q$));
set request.jwt.claim.sub = '93999999-0000-0000-0000-000000000004';
insert into results (who,what,expected,result) values
 ('식당R','소매 고객은 조회 0건','0', pg_temp.val($q$select count(*)::text from public.supplier_statement_files$q$)),
 ('식당R','소매 고객의 등록 시도 → 거부','DENIED', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path,uploaded_by) values ('a3999999-0000-0000-0000-000000000001','x','a3999999-0000-0000-0000-000000000001/z1','93999999-0000-0000-0000-000000000004')$q$));
reset role; set role anon; set request.jwt.claim.role = 'anon'; set request.jwt.claim.sub = '';
insert into results (who,what,expected,result) values
 ('비로그인','조회 → 거부 또는 0건','0', case when pg_temp.val($q$select count(*)::text from public.supplier_statement_files$q$) like 'ERROR%' then '0' else pg_temp.val($q$select count(*)::text from public.supplier_statement_files$q$) end),
 ('비로그인','등록 시도 → 거부','DENIED', pg_temp.try($q$insert into public.supplier_statement_files (wholesaler_id,file_name,storage_path) values ('a3999999-0000-0000-0000-000000000001','x','a3999999-0000-0000-0000-000000000001/w1')$q$));

-- ========== 7-D. 서버(service_role) ==========
reset role; set role service_role;
insert into results (who,what,expected,result) values
 ('서버','[정보] 서버(service_role)도 트리거 때문에 파일 정보 수정 불가','DENIED: STATEMENT_FILE_IMMUTABLE', pg_temp.try($q$update public.supplier_statement_files set file_name='서버수정' where id='c3999999-0000-0000-0000-0000000000a1'$q$));
reset role;

select '--- 결과 ---' as t;
select no, who, what, expected, result,
       case when result = expected or (expected = 'DENIED' and result like 'DENIED%') then 'PASS' else 'FAIL' end as verdict
  from results order by no;
select count(*) filter (where result = expected or (expected = 'DENIED' and result like 'DENIED%')) as pass,
       count(*) filter (where not (result = expected or (expected = 'DENIED' and result like 'DENIED%'))) as fail
  from results;
