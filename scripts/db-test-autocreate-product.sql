\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('11111111-1111-1111-1111-111111111111','a@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values ('11111111-1111-1111-1111-111111111111','wholesaler','A','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A');

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 부위까지 있는 이력 / 부위 없는 이력
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소',null,'1+',current_date-2,'○○도축장');

select '--- C1: 상품이 하나도 없는 상태에서 스캔 ---' as t;
select count(*) as products_before from public.products;
select public.record_inbound_scan('002111111111', 8.20, 'BARCODE_SCAN') -> 'status' as should_be_pending;

select '--- C2: 이력으로 상품 자동 생성 ---' as t;
select public.autocreate_product_for_scan((select id from public.inbound_scans where trace_no='002111111111'));
select name, category, subcategory, grade, origin, base_price, unit, stock_quantity from public.products;

select '--- C3: 같은 부위 재스캔 → 학습된 매핑으로 바로 NORMAL ---' as t;
select public.upsert_master_livestock('002333333333','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-1,'○○도축장');
select public.record_inbound_scan('002333333333', 7.50, 'BARCODE_SCAN') -> 'status' as should_be_normal;
select count(*) as products_should_still_be_1 from public.products;
select stock_quantity as should_be_15_70 from public.products;

select '--- C4: 부위 없으면 자동 생성 안 함 ---' as t;
select public.record_inbound_scan('002222222222', 5.00, 'BARCODE_SCAN') -> 'status' as should_be_pending;
select public.autocreate_product_for_scan((select id from public.inbound_scans where trace_no='002222222222')) as should_be_insufficient;
select count(*) as products_should_still_be_1 from public.products;
