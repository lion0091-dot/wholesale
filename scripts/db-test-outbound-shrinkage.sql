-- 출고 중 박스 소진 → 감량 기록(마이그레이션 229). 실중량 출고 + "박스 다 썼음" 흐름과 거부 경로.
--
-- 실행(로컬 Docker DB, 전부 롤백):
--   (echo "begin;"; cat scripts/db-test-outbound-shrinkage.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

insert into auth.users (id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('22222222-2222-2222-2222-222222222222','b@t.com'),
 ('33333333-3333-3333-3333-333333333333','r@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone,is_supplier,is_verified) values
 ('11111111-1111-1111-1111-111111111111','wholesaler','A사장','010',true,true),
 ('22222222-2222-2222-2222-222222222222','wholesaler','B사장','010',true,true),
 ('33333333-3333-3333-3333-333333333333','retailer','식당','010',false,false)
 on conflict (id) do update set role=excluded.role, is_supplier=excluded.is_supplier, is_verified=excluded.is_verified;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name,status) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A','active'),
 ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','B축산','1110000002','B','active');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('dddddddd-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','○○식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id)
 values ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity,is_active) values
 ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',30,true);

-- 박스 A(오래됨) 10kg·단가 40,000 / 박스 B 10kg / 박스 C 10kg(이 주문에 쓰지 않음). 장부 입고 합 30 = 재고 30.
insert into public.inbound_scans (id,wholesaler_id,trace_no,weight,unit,scan_type,status,product_id,remaining_weight,purchase_unit_price,created_at) values
 ('b0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','088800000001',10,'kg','MANUAL','NORMAL','cccccccc-0000-0000-0000-000000000001',10,40000, now() - interval '3 days'),
 ('b0000000-0000-0000-0000-00000000000b','aaaaaaaa-0000-0000-0000-000000000001','088800000002',10,'kg','MANUAL','NORMAL','cccccccc-0000-0000-0000-000000000001',10,40000, now() - interval '2 days'),
 ('b0000000-0000-0000-0000-00000000000c','aaaaaaaa-0000-0000-0000-000000000001','088800000003',10,'kg','MANUAL','NORMAL','cccccccc-0000-0000-0000-000000000001',10,40000, now() - interval '1 day');
insert into public.stock_ledger (wholesaler_id,product_id,inbound_scan_id,qty_delta,event_type,source_type,source_id)
select 'aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001', id, 10, 'INBOUND','inbound_scan', id
from public.inbound_scans where wholesaler_id = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-SHR-1',680000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount)
 values ('eeeeeeee-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','한우 등심',68000,10,680000);

set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';

select '--- S1: 확정 시 자동 배정은 A 10kg 전부 (장부상) ---' as t;
select trace_no, remaining_weight from public.inbound_scans order by created_at;

select '--- S2: 실중량 9.5kg으로 A를 스캔 → A 잔량 0.5(장부), 필요량 0.5 남음 ---' as t;
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','088800000001', 9.5);
do $$ declare v numeric; begin
  select remaining_weight into v from public.inbound_scans where id = 'b0000000-0000-0000-0000-00000000000a';
  if v = 0.5 then raise notice 'PASS: A 잔량 0.5'; else raise exception 'FAIL: A 잔량 %', v; end if;
end $$;

select '--- S3: 이 주문에 배정되지 않은 박스 C는 감량 처리 거부 ---' as t;
do $$ begin
  perform public.exhaust_box_after_outbound('eeeeeeee-0000-0000-0000-000000000001','088800000003');
  raise exception 'FAIL: 배정 안 된 박스가 비워짐';
exception when others then
  if sqlerrm = 'BOX_NOT_ASSIGNED_TO_ORDER' then raise notice 'PASS: 배정 안 된 박스 거부';
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- S4: A를 "다 썼음" → 0.5kg 감량(LOSS), 박스 비움, 손실 금액 20,000원 ---' as t;
select public.exhaust_box_after_outbound('eeeeeeee-0000-0000-0000-000000000001','088800000001');
do $$ declare v_rem numeric; v_loss numeric; v_amt numeric; v_code text; v_ledger numeric; begin
  select remaining_weight into v_rem from public.inbound_scans where id = 'b0000000-0000-0000-0000-00000000000a';
  select weight, loss_amount, reason_code into v_loss, v_amt, v_code from public.box_disposals where inbound_scan_id = 'b0000000-0000-0000-0000-00000000000a';
  select sum(qty_delta) into v_ledger from public.stock_ledger where inbound_scan_id = 'b0000000-0000-0000-0000-00000000000a' and event_type = 'LOSS';
  if v_rem = 0 and v_loss = 0.5 and v_amt = 20000 and v_code = 'SHRINKAGE' and v_ledger = -0.5
    then raise notice 'PASS: 감량 0.5kg / 20000원 / SHRINKAGE / 장부 LOSS -0.5';
    else raise exception 'FAIL: rem=% weight=% amount=% code=% ledger=%', v_rem, v_loss, v_amt, v_code, v_ledger; end if;
end $$;

select '--- S5: 이미 비운 박스에 다시 호출해도 감량 0, 중복 기록 없음 ---' as t;
do $$ declare v jsonb; v_cnt int; begin
  v := public.exhaust_box_after_outbound('eeeeeeee-0000-0000-0000-000000000001','088800000001');
  select count(*) into v_cnt from public.box_disposals where inbound_scan_id = 'b0000000-0000-0000-0000-00000000000a';
  if (v->>'weight')::numeric = 0 and v_cnt = 1 then raise notice 'PASS: 중복 감량 없음';
  else raise exception 'FAIL: % / %', v, v_cnt; end if;
end $$;

select '--- S6: 부족한 0.5kg을 다른 박스 B에서 채움 → 주문 충족 ---' as t;
select public.record_outbound_scan('eeeeeeee-0000-0000-0000-000000000001','088800000002');
do $$ declare v_rem numeric; begin
  select remaining_weight into v_rem from public.inbound_scans where id = 'b0000000-0000-0000-0000-00000000000b';
  if v_rem = 9.5 then raise notice 'PASS: B 잔량 9.5'; else raise exception 'FAIL: B 잔량 %', v_rem; end if;
end $$;

select '--- S7: 상품 재고 = 30 - 9.5 - 0.5(감량) - 0.5 = 19.5, 박스 잔량 합과 일치 ---' as t;
do $$ declare v_stock numeric; v_boxes numeric; begin
  select stock_quantity into v_stock from public.products where id = 'cccccccc-0000-0000-0000-000000000001';
  select sum(remaining_weight) into v_boxes from public.inbound_scans where wholesaler_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if v_stock = 19.5 and v_boxes = 19.5 then raise notice 'PASS: 재고 19.5 = 박스 합 19.5';
  else raise exception 'FAIL: stock=% boxes=%', v_stock, v_boxes; end if;
end $$;

select '--- S8: 다른 업체 직원은 이 주문으로 호출 불가 ---' as t;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin
  perform public.exhaust_box_after_outbound('eeeeeeee-0000-0000-0000-000000000001','088800000001');
  raise exception 'FAIL: 남의 주문 처리됨';
exception when others then
  if sqlerrm = 'ORDER_NOT_FOUND' then raise notice 'PASS: 남의 주문 거부';
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

select '--- S9: 고객(식당) 계정은 호출 불가 ---' as t;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ begin
  perform public.exhaust_box_after_outbound('eeeeeeee-0000-0000-0000-000000000001','088800000001');
  raise exception 'FAIL: 고객이 처리함';
exception when others then
  if sqlerrm = 'NOT_A_SUPPLIER' then raise notice 'PASS: 고객 거부';
  else raise exception 'FAIL: %', sqlerrm; end if;
end $$;

reset role;
select '--- S10: 재고·박스·원장 점검(213)에 새 어긋남 없음 ---' as t;
select check_key, violations from public.stock_integrity_violations('aaaaaaaa-0000-0000-0000-000000000001') where violations > 0;
