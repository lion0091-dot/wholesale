\set ON_ERROR_STOP on
insert into auth.users (id,email) values ('11111111-1111-1111-1111-111111111111','a@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values ('11111111-1111-1111-1111-111111111111','wholesaler','A','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A');
insert into public.products (id,wholesaler_id,name,category,origin,base_price,unit,stock_quantity)
 values ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','수입 삼겹살','돼지','수입산',18000,'kg',20);

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select '--- A1: 실사로 20 → 18 ---' as t;
select public.adjust_product_stock('cccccccc-0000-0000-0000-000000000001', 18, 'STOCKTAKE');
select stock_quantity as should_be_18 from public.products where id='cccccccc-0000-0000-0000-000000000001';
select event_type, qty_delta, reason from public.stock_ledger order by created_at;

select '--- A2: 폐기로 18 → 15 (LOSS로 기록되어야) ---' as t;
select public.adjust_product_stock('cccccccc-0000-0000-0000-000000000001', 15, 'DISPOSAL', '유통기한 경과');
select event_type, qty_delta, reason from public.stock_ledger order by created_at;
select stock_quantity as should_be_15 from public.products where id='cccccccc-0000-0000-0000-000000000001';

select '--- A3: 잘못된 사유 코드 ---' as t;
do $$ begin
  perform public.adjust_product_stock('cccccccc-0000-0000-0000-000000000001', 10, 'HACK');
  raise exception 'FAIL: 잘못된 사유가 통과됨';
exception when others then
  if sqlerrm='INVALID_REASON' then raise notice 'PASS: INVALID_REASON 차단';
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- A4: 여러 번 조정 가능(멱등 인덱스에 막히면 안 됨) ---' as t;
select public.adjust_product_stock('cccccccc-0000-0000-0000-000000000001', 16, 'RETURN') -> 'changed';
select public.adjust_product_stock('cccccccc-0000-0000-0000-000000000001', 17, 'OTHER') -> 'changed';
select stock_quantity as should_be_17 from public.products where id='cccccccc-0000-0000-0000-000000000001';

select '--- A5: 변화 없으면 no-op ---' as t;
select public.adjust_product_stock('cccccccc-0000-0000-0000-000000000001', 17, 'STOCKTAKE') -> 'changed' as should_be_false;
