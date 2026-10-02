-- 금액은 원 단위 정수로 확정된다 (마이그레이션 214, 2026-10-02 대표 결정: "반올림하자")
--
-- 출고 확정(finalize_order_shipment)이 실제 출고량으로 금액을 다시 계산할 때, 접수 때(원 단위 반올림)와 같은 규칙을 쓴다.
-- 중량·수량은 그램(0.001kg) 그대로이고 금액만 반올림된다. 이전에는 소수 둘째 자리(16,513.20원)까지 저장돼
-- 항목 금액·합계에 원 미만이 남았다.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-money-rounding.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

insert into auth.users (id,email) values
 ('88888888-8888-0000-0000-000000000001','a@round.test'),
 ('88888888-8888-0000-0000-000000000002','r@round.test');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('88888888-8888-0000-0000-000000000001','wholesaler','A사장','010',true,true),
 ('88888888-8888-0000-0000-000000000002','retailer','식당','010',false,false)
 on conflict (id) do update set role=excluded.role, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status,min_order_amount) values
 ('a8888888-0000-0000-0000-000000000001','88888888-8888-0000-0000-000000000001','반올림축산','8880000001','A','active',0);
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address) values
 ('d8888888-0000-0000-0000-000000000001','88888888-8888-0000-0000-000000000002','식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id) values
 ('a8888888-0000-0000-0000-000000000001','d8888888-0000-0000-0000-000000000001');
-- 상품 2개: 19,800원/kg(0.834kg → 16,513.2) 와 12,345원/kg(0.5kg → 6,172.5 = 반올림 경계)
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('c8888888-0000-0000-0000-000000000001','a8888888-0000-0000-0000-000000000001','돼지 삼겹','돼지','삼겹살','국내산',null,19800,'kg',0),
 ('c8888888-0000-0000-0000-000000000002','a8888888-0000-0000-0000-000000000001','돼지 목살','돼지','목살','국내산',null,12345,'kg',0);

grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date,text,text) to authenticated;
set role authenticated; set request.jwt.claim.sub = '88888888-8888-0000-0000-000000000001';
select public.upsert_master_livestock('002888888801','individual','mtrace_livestock','{}'::jsonb,'돼지','돼지','삼겹살',null,current_date-3,'○○도축장');
select public.upsert_master_livestock('002888888802','individual','mtrace_livestock','{}'::jsonb,'돼지','돼지','목살',null,current_date-3,'○○도축장');
select public.record_inbound_scan('002888888801', 0.834,'BARCODE_SCAN','c8888888-0000-0000-0000-000000000001') -> 'status';
select public.record_inbound_scan('002888888802', 0.5,'BARCODE_SCAN','c8888888-0000-0000-0000-000000000002') -> 'status';

reset role;
-- 주문 접수: 둘 다 1kg씩 (접수 때 금액은 단가 × 수량, 정수)
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('e8888888-0000-0000-0000-000000000001','a8888888-0000-0000-0000-000000000001','d8888888-0000-0000-0000-000000000001','ORD-R1',32145,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount) values
 ('e8888888-0000-0000-0000-000000000001','c8888888-0000-0000-0000-000000000001','돼지 삼겹',19800,0.834,16513),
 ('e8888888-0000-0000-0000-000000000001','c8888888-0000-0000-0000-000000000002','돼지 목살',12345,0.5,6173);

set role authenticated; set request.jwt.claim.sub = '88888888-8888-0000-0000-000000000001';
update public.orders set status='confirmed' where id='e8888888-0000-0000-0000-000000000001';
select public.record_outbound_scan('e8888888-0000-0000-0000-000000000001','002888888801') -> 'taken';
select public.record_outbound_scan('e8888888-0000-0000-0000-000000000001','002888888802') -> 'taken';
select public.finalize_order_shipment('e8888888-0000-0000-0000-000000000001', true);

reset role;
do $$
declare
  v_a numeric; v_b numeric; v_qa numeric; v_qb numeric; v_total numeric;
begin
  select subtotal_amount, shipped_quantity into v_a, v_qa from public.order_items where order_id='e8888888-0000-0000-0000-000000000001' and product_id='c8888888-0000-0000-0000-000000000001';
  select subtotal_amount, shipped_quantity into v_b, v_qb from public.order_items where order_id='e8888888-0000-0000-0000-000000000001' and product_id='c8888888-0000-0000-0000-000000000002';
  select total_amount into v_total from public.orders where id='e8888888-0000-0000-0000-000000000001';

  if v_a = 16513 and v_a = round(v_a) then raise notice 'PASS: 19,800 × 0.834kg = 16,513.2 → 원 단위 16,513 (받은 값 %)', v_a;
  else raise exception 'FAIL: 삼겹 금액이 원 단위가 아님 (%)', v_a; end if;

  if v_b = 6173 then raise notice 'PASS: 12,345 × 0.5kg = 6,172.5 → 반올림 6,173 (받은 값 %)', v_b;
  else raise exception 'FAIL: 목살 금액 반올림 틀림 (%)', v_b; end if;

  if v_total = v_a + v_b and v_total = round(v_total) then raise notice 'PASS: 주문 합계 = 항목 금액의 합 = % (원 단위)', v_total;
  else raise exception 'FAIL: 합계 불일치 (합계 %, 항목합 %)', v_total, v_a + v_b; end if;

  if v_qa = 0.834 and v_qb = 0.5 then raise notice 'PASS: 중량(수량)은 그램 그대로 — 0.834kg·0.500kg 변경 없음';
  else raise exception 'FAIL: 출고 중량이 바뀜 (%, %)', v_qa, v_qb; end if;
end $$;
