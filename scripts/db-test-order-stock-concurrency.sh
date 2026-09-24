#!/usr/bin/env bash
# 동시 확정 레이스 재현 (20260930000099 검증) — psql 세션 두 개가 같은 상품의
# 서로 다른 주문을 거의 동시에 확정한다. 기초재고 10, 주문 6 + 6.
#
# 기대: 한 건만 확정되고 다른 한 건은 INSUFFICIENT_STOCK으로 막힌다.
#       끝난 뒤 표시 재고 == 원장 합계 == 4 (음수·불일치 없음).
#
# 실행(로컬 Docker DB): bash scripts/db-test-order-stock-concurrency.sh
# 롤백형 스크립트가 아니라 시드를 실제로 넣고 끝에 지운다 — 고유 ID만 쓴다.
set -euo pipefail

PSQL="docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
OWNER='97999999-0000-0000-0000-000000000001'
PRODUCT='c7999999-0000-0000-0000-000000000001'

cleanup() {
  $PSQL <<'SQL' >/dev/null 2>&1 || true
delete from public.stock_ledger where product_id='c7999999-0000-0000-0000-000000000001';
delete from public.orders where wholesaler_id='a7999999-0000-0000-0000-000000000001';
delete from public.wholesaler_retailers where wholesaler_id='a7999999-0000-0000-0000-000000000001';
delete from public.retailers where id='d7999999-0000-0000-0000-000000000001';
delete from public.products where id='c7999999-0000-0000-0000-000000000001';
delete from public.wholesalers where id='a7999999-0000-0000-0000-000000000001';
delete from public.profiles where id in ('97999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000003');
delete from auth.users where id in ('97999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000003');
SQL
}
trap cleanup EXIT
cleanup

$PSQL <<'SQL'
insert into auth.users (id,email) values
 ('97999999-0000-0000-0000-000000000001','owner@conc.test'),
 ('97999999-0000-0000-0000-000000000003','retailer@conc.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('97999999-0000-0000-0000-000000000001','wholesaler','A사장','010'),
 ('97999999-0000-0000-0000-000000000003','retailer','식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('a7999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000001','A축산','9790000001','A','active');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('d7999999-0000-0000-0000-000000000001','97999999-0000-0000-0000-000000000003','식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id,status)
 values ('a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','active');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('c7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','기초재고 상품','돼지','삼겹살','국내산',null,20000,'kg',10);
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address) values
 ('e7999999-0000-0000-0000-000000000001','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','CONC-1',120000,'pending','서울'),
 ('e7999999-0000-0000-0000-000000000002','a7999999-0000-0000-0000-000000000001','d7999999-0000-0000-0000-000000000001','CONC-2',120000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e7999999-0000-0000-0000-000000000001','c7999999-0000-0000-0000-000000000001','기초재고 상품',20000,6,120000),
 ('e7999999-0000-0000-0000-000000000002','c7999999-0000-0000-0000-000000000001','기초재고 상품',20000,6,120000);
SQL

confirm() {
  local order_id="$1" label="$2" sleep_before_commit="$3"
  $PSQL 2>&1 <<SQL | sed "s/^/[$label] /" || true
begin;
set role authenticated; set request.jwt.claim.sub = '$OWNER';
update public.orders set status='confirmed' where id='$order_id';
select pg_sleep($sleep_before_commit);
commit;
select '$label committed' as t;
SQL
}

echo "=== 세션1: 주문1 확정(커밋 전 4초 대기) / 세션2: 1초 뒤 주문2 확정 ==="
confirm 'e7999999-0000-0000-0000-000000000001' S1 4 &
sleep 1
confirm 'e7999999-0000-0000-0000-000000000002' S2 0 &
wait

echo "=== 결과 ==="
$PSQL -At <<'SQL'
select 'orders: ' || string_agg(order_number || '=' || status, ', ' order by order_number) from public.orders where wholesaler_id='a7999999-0000-0000-0000-000000000001';
select 'products.stock_quantity = ' || stock_quantity from public.products where id='c7999999-0000-0000-0000-000000000001';
select 'ledger sum = ' || coalesce(sum(qty_delta),0) from public.stock_ledger where product_id='c7999999-0000-0000-0000-000000000001';
select case
  when (select count(*) from public.orders where wholesaler_id='a7999999-0000-0000-0000-000000000001' and status='confirmed') = 1
   and (select stock_quantity from public.products where id='c7999999-0000-0000-0000-000000000001') = 4
   and (select coalesce(sum(qty_delta),0) from public.stock_ledger where product_id='c7999999-0000-0000-0000-000000000001') = 4
  then 'PASS: 한 건만 확정, 표시 재고 = 원장 합계 = 4'
  else 'FAIL: 이중 차감 또는 불일치'
end;
SQL
