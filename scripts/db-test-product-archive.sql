\set ON_ERROR_STOP on
insert into auth.users (id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('33333333-3333-3333-3333-333333333333','r@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('11111111-1111-1111-1111-111111111111','wholesaler','A','010'),
 ('33333333-3333-3333-3333-333333333333','retailer','식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A','active');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('dddddddd-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status)
 values ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','active');

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');

select '--- A1: 자동 생성 상품은 판매중지 + 0원 ---' as t;
select public.record_inbound_scan('002111111111', 8.20, 'BARCODE_SCAN') -> 'status';
select public.autocreate_product_for_scan((select id from public.inbound_scans where trace_no='002111111111'));
select name, base_price, is_active as should_be_false, archived_at from public.products;

select '--- A2: 입출고 기록이 있으면 삭제 불가(원장 FK) ---' as t;
do $$ begin
  delete from public.products where id = (select id from public.products limit 1);
  raise exception 'FAIL: 기록 있는 상품이 삭제됨';
exception when foreign_key_violation then raise notice 'PASS: 외래키로 삭제 차단됨';
end $$;
select public.product_has_stock_history((select id from public.products limit 1)) as should_be_true;

select '--- A3: 보관하면 판매도 함께 내려간다 ---' as t;
update public.products set is_active = true, base_price = 68000;
select public.set_product_archived((select id from public.products limit 1), true);
select is_active as should_be_false, (archived_at is not null) as should_be_true from public.products;

select '--- A4: 보관 상품은 고객에게 안 보인다 ---' as t;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as retailer_sees_should_be_0 from public.products;

select '--- A5: 복원하면 다시 보인다(판매중은 직접 켜야 함) ---' as t;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.set_product_archived((select id from public.products limit 1), false);
update public.products set is_active = true;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as retailer_sees_should_be_1 from public.products;
