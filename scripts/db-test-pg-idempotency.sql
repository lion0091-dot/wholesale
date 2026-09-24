-- PG 결제 1건 = 주문 1건 멱등키 검증 (20260930000101)
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/db-test-pg-idempotency.sql
\set ON_ERROR_STOP on
begin;

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
    execute p_sql;
    return 'ALLOWED';
exception when others then
    return 'DENIED: ' || split_part(sqlerrm, ':', 1);
end $$;

insert into auth.users (id,email) values
 ('95999999-0000-0000-0000-000000000001','owner@pg.test'),
 ('95999999-0000-0000-0000-000000000003','retailer@pg.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('95999999-0000-0000-0000-000000000001','wholesaler','A사장','010'),
 ('95999999-0000-0000-0000-000000000003','retailer','식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a5999999-0000-0000-0000-000000000001','95999999-0000-0000-0000-000000000001','A축산','9590000001','A','active');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('d5999999-0000-0000-0000-000000000001','95999999-0000-0000-0000-000000000003','식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status)
 values ('a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','active');

select '--- P1: 같은 pg_order_id로 주문 두 번 → 두 번째는 유니크 위반 ---' as t;
select pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,payment_method,payment_status,pg_payment_key,pg_order_id,delivery_address)
  values ('a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','PG-1',10000,'pending','pg','paid','pk_1','pgAAAA','서울')$q$) as first_should_be_allowed;
select pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,payment_method,payment_status,pg_payment_key,pg_order_id,delivery_address)
  values ('a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','PG-2',10000,'pending','pg','paid','pk_1','pgAAAA','서울')$q$) as second_should_be_denied;

select '--- P2: pg_order_id가 NULL인 직접정산 주문은 몇 개든 된다 ---' as t;
select pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,payment_method,delivery_address)
  values ('a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','PP-1',10000,'pending','prepaid','서울')$q$) as allowed_1;
select pg_temp.try($q$insert into public.orders (wholesaler_id,retailer_id,order_number,total_amount,status,payment_method,delivery_address)
  values ('a5999999-0000-0000-0000-000000000001','d5999999-0000-0000-0000-000000000001','PP-2',10000,'pending','prepaid','서울')$q$) as allowed_2;

select count(*) filter (where pg_order_id='pgAAAA') as pg_orders_should_be_1,
       count(*) filter (where pg_order_id is null) as prepaid_orders_should_be_2
  from public.orders where wholesaler_id='a5999999-0000-0000-0000-000000000001';

rollback;
