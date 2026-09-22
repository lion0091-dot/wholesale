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

-- 판매가 있는 상품 / 판매가 0원 상품
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',10,true),
 ('cccccccc-0000-0000-0000-000000000009','aaaaaaaa-0000-0000-0000-000000000001','값 미정 상품','소','채끝','국내산','1+',0,'kg',5,true);

select '--- P1: 공급사는 둘 다 보임 ---' as t;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select count(*) as supplier_sees_should_be_2 from public.products;

select '--- P2: 고객은 판매가 있는 것만 ---' as t;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select name, base_price from public.products;
