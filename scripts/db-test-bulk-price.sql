\set ON_ERROR_STOP on
insert into auth.users (id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('22222222-2222-2222-2222-222222222222','b@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('11111111-1111-1111-1111-111111111111','wholesaler','A','010'),
 ('22222222-2222-2222-2222-222222222222','wholesaler','B','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A'),
 ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','B축산','2220000002','B');
insert into public.products (id,wholesaler_id,name,category,origin,base_price,unit,stock_quantity,is_active) values
 ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','국내산',0,'kg',0,false),
 ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 채끝','소','국내산',0,'kg',0,false),
 ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','보관된상품','소','국내산',0,'kg',0,false),
 ('dddddddd-0000-0000-0000-000000000009','bbbbbbbb-0000-0000-0000-000000000002','남의상품','소','국내산',0,'kg',0,false);
update public.products set archived_at = now() where id='cccccccc-0000-0000-0000-000000000003';

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select '--- B1: 정상 2건 반영 + 판매중 전환 ---' as t;
select public.bulk_update_product_prices(
  '[{"id":"cccccccc-0000-0000-0000-000000000001","price":"68000"},
    {"id":"cccccccc-0000-0000-0000-000000000002","price":"52000"}]'::jsonb, true);
select name, base_price, is_active from public.products
 where wholesaler_id='aaaaaaaa-0000-0000-0000-000000000001' order by name;

select '--- B2: 빈 칸·0·음수는 건너뜀 (기존 가격 보존) ---' as t;
select public.bulk_update_product_prices(
  '[{"id":"cccccccc-0000-0000-0000-000000000001","price":""},
    {"id":"cccccccc-0000-0000-0000-000000000002","price":"0"},
    {"id":"cccccccc-0000-0000-0000-000000000002","price":"-5"}]'::jsonb, false);
select base_price as should_still_be_68000 from public.products where id='cccccccc-0000-0000-0000-000000000001';

select '--- B3: 남의 상품 / 보관 상품은 반영 안 됨 ---' as t;
select public.bulk_update_product_prices(
  '[{"id":"dddddddd-0000-0000-0000-000000000009","price":"99000"},
    {"id":"cccccccc-0000-0000-0000-000000000003","price":"99000"}]'::jsonb, true);
reset role;
select name, base_price from public.products
 where id in ('dddddddd-0000-0000-0000-000000000009','cccccccc-0000-0000-0000-000000000003') order by name;

select '--- B4: 망가진 ID는 전체를 실패시키지 않는다 ---' as t;
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.products set base_price = 0 where id='cccccccc-0000-0000-0000-000000000002';
select public.bulk_update_product_prices(
  '[{"id":"망가진값","price":"1000"},
    {"id":"cccccccc-0000-0000-0000-000000000002","price":"52000"}]'::jsonb, false);
select base_price as should_be_52000 from public.products where id='cccccccc-0000-0000-0000-000000000002';
