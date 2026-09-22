\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('11111111-1111-1111-1111-111111111111','a@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values ('11111111-1111-1111-1111-111111111111','wholesaler','A','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity)
 values ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select '--- I1: 업로드 작업/행 생성 ---' as t;
insert into public.inbound_import_jobs (id, wholesaler_id, file_name, total_rows, status, created_by)
 values ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','입고.csv',2,'PENDING','11111111-1111-1111-1111-111111111111');
insert into public.inbound_import_rows (job_id,row_no,trace_no,weight) values
 ('bbbbbbbb-0000-0000-0000-000000000001',1,'002111111111',8.20),
 ('bbbbbbbb-0000-0000-0000-000000000001',2,'002111111111',8.20);
select count(*) as rows_should_be_2 from public.inbound_import_rows;

select '--- I2: 엑셀은 같은 번호+같은 중량도 중복 경고 없이 통과 ---' as t;
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.record_inbound_scan('002111111111', 8.20, 'EXCEL', 'cccccccc-0000-0000-0000-000000000002') -> 'status' as first_row;
select public.record_inbound_scan('002111111111', 8.20, 'EXCEL', 'cccccccc-0000-0000-0000-000000000002') -> 'status' as second_row_same;
select stock_quantity as should_be_16_40 from public.products where id='cccccccc-0000-0000-0000-000000000002';

select '--- I3: 같은 값이라도 바코드 스캔이면 경고 ---' as t;
do $$ begin
  perform public.record_inbound_scan('002111111111', 8.20, 'BARCODE_SCAN', 'cccccccc-0000-0000-0000-000000000002');
  raise exception 'FAIL: 경고 없이 통과됨';
exception when others then
  if sqlerrm like 'DUPLICATE_SUSPECTED:%' then raise notice 'PASS: %', sqlerrm;
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- I4: 업로드 행 RLS — 남의 작업은 안 보임 ---' as t;
reset role;
insert into auth.users (id,email) values ('22222222-2222-2222-2222-222222222222','b@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values ('22222222-2222-2222-2222-222222222222','wholesaler','B','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('bbbbbbbb-1111-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','B축산','2220000002','B');
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select count(*) as b_sees_jobs_should_be_0 from public.inbound_import_jobs;
select count(*) as b_sees_rows_should_be_0 from public.inbound_import_rows;
