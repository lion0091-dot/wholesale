-- 자체 세트 상품(BOM) + 이력 역추적 (23단계) 기능 테스트
\set ON_ERROR_STOP on

insert into auth.users (id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('22222222-2222-2222-2222-222222222222','b@t.com'),
 ('33333333-3333-3333-3333-333333333333','r@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('11111111-1111-1111-1111-111111111111','wholesaler','A사장','010'),
 ('22222222-2222-2222-2222-222222222222','wholesaler','B사장','010'),
 ('33333333-3333-3333-3333-333333333333','retailer','식당','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A'),
 ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','B축산','1110000002','B');
insert into public.retailers (id,profile_id,restaurant_name,representative_name,delivery_address)
 values ('dddddddd-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','○○식당','사장','서울');
insert into public.wholesaler_retailers (wholesaler_id,retailer_id)
 values ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001');

-- 구성품 2종 (삼겹살 / 목살)
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','국내산 삼겹살','돼지','삼겹살','국내산','1등급',18000,'kg',0),
 ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','국내산 목살','돼지','목살','국내산','1등급',16000,'kg',0);

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- 박스 4개: 삼겹살 6.0 + 4.0(기한 D+10) / 목살 3.0 + 3.0(기한 D+5)
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'돼지','돼지','삼겹살','1등급',current_date-5,'○○도축장');
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'돼지','돼지','삼겹살','1등급',current_date-4,'○○도축장');
select public.upsert_master_livestock('002333333333','individual','mtrace_livestock','{}'::jsonb,'돼지','돼지','목살','1등급',current_date-3,'○○도축장');
select public.upsert_master_livestock('002444444444','individual','mtrace_livestock','{}'::jsonb,'돼지','돼지','목살','1등급',current_date-2,'○○도축장');
select public.record_inbound_scan('002111111111',6.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000001',null,null,null,false,current_date+10) -> 'status';
select public.record_inbound_scan('002222222222',4.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000001',null,null,null,false,current_date+10) -> 'status';
select public.record_inbound_scan('002333333333',3.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002',null,null,null,false,current_date+5) -> 'status';
select public.record_inbound_scan('002444444444',3.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000002',null,null,null,false,current_date+20) -> 'status';

select '--- N1: 세트 구성 저장 (상품도 새로 만든다) ---' as t;
select public.save_product_bundle(
    '[{"product_id":"cccccccc-0000-0000-0000-000000000001","quantity":2},
      {"product_id":"cccccccc-0000-0000-0000-000000000002","quantity":1}]'::jsonb,
    null, null, '삼겹살+목살 실속세트', 45000, null, '3~4인 가정용') as should_have_BND_0001;

select name, unit, base_price, is_active, stock_quantity, origin, category
  from public.products where name='삼겹살+목살 실속세트';

select '--- N2: 제작 가능 수량 = min(삼겹 10/2=5, 목살 6/1=6) = 5 ---' as t;
select bundle_code, buildable, on_hand_sets, jsonb_array_length(components) as component_count
  from public.list_product_bundles();

select '--- N3: 세트 2개 제작 ---' as t;
select (public.assemble_product_bundle((select id from public.product_bundles), 2)) -> 'sets' as sets;

select '구성품 재고(삼겹 6.0 / 목살 4.0 남아야 함)' as t, name, stock_quantity
  from public.products where id in
   ('cccccccc-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002') order by name;
select '세트 재고(2세트)' as t, stock_quantity, unit from public.products where name='삼겹살+목살 실속세트';

select '--- N4: 역추적 — 세트 박스마다 원본 이력번호가 붙어 있다 ---' as t;
select set_no, total_weight, best_before, source_count, source_traces
  from public.list_bundle_assemblies() order by set_no;

select '--- N5: 유통기한 승계 — 구성 박스 중 가장 이른 날짜(D+5) ---' as t;
select set_no, best_before = current_date+5 as should_be_true
  from public.list_bundle_assemblies() order by set_no limit 1;

select '--- N6: 기한 지난 박스는 세트에 안 들어간다 ---' as t;
select public.upsert_master_livestock('002555555555','individual','mtrace_livestock','{}'::jsonb,'돼지','돼지','삼겹살','1등급',current_date-30,'○○도축장');
select public.record_inbound_scan('002555555555',50.000,'BARCODE_SCAN','cccccccc-0000-0000-0000-000000000001',null,null,null,false,current_date-1) -> 'expired';
select bundle_code, buildable as should_still_be_3 from public.list_product_bundles();

select '--- N7: 구성품 부족이면 제작 자체가 막힌다 ---' as t;
do $$ begin
  perform public.assemble_product_bundle((select id from public.product_bundles), 50);
  raise notice 'FAIL: 막히지 않음';
exception when others then raise notice 'PASS: %', sqlerrm;
end $$;
select '부족 실패 후에도 세트 재고 2 유지' as t, stock_quantity from public.products where name='삼겹살+목살 실속세트';

select '--- N8: 세트 주문 확정 → 세트 박스가 선입선출로 나간다 ---' as t;
reset role;
insert into public.orders (id,wholesaler_id,retailer_id,order_number,total_amount,status,delivery_address)
 values ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','ORD-B1',45000,'pending','서울');
insert into public.order_items (order_id,product_id,product_name,unit_price,quantity,subtotal_amount)
 select 'eeeeeeee-0000-0000-0000-000000000001', id, name, 45000, 1, 45000 from public.products where name='삼겹살+목살 실속세트';
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.orders set status='confirmed' where id='eeeeeeee-0000-0000-0000-000000000001';
select '세트 재고(1세트 남아야 함)' as t, stock_quantity from public.products where name='삼겹살+목살 실속세트';

select '--- N9: 거래명세서 이력번호가 구성 이력번호로 전개된다 ---' as t;
select product_name, trace_no, quantity, grade, slaughter_date
  from public.get_order_trace_numbers('eeeeeeee-0000-0000-0000-000000000001');

select '--- N10: 라벨 한 장에 구성 이력번호가 모두 실린다 ---' as t;
select trace_no, quantity, unit, is_bundle, total_weight, jsonb_array_length(source_traces) as traces
  from public.get_order_labels('eeeeeeee-0000-0000-0000-000000000001');

select '--- N11: 출고된 세트는 해체할 수 없다 ---' as t;
do $$
declare v_id uuid;
begin
  select assembly_id into v_id from public.list_bundle_assemblies() order by set_no limit 1;
  perform public.disassemble_bundle_assembly(v_id);
  raise notice 'FAIL: 막히지 않음';
exception when others then raise notice 'PASS: %', sqlerrm;
end $$;

select '--- N12: 안 나간 세트 해체 → 구성품 재고 복원 ---' as t;
select public.disassemble_bundle_assembly(
    (select assembly_id from public.list_bundle_assemblies() where remaining > 0 order by set_no desc limit 1));
select '구성품 재고(삼겹 58.0 / 목살 5.0)' as t, name, stock_quantity from public.products
 where id in ('cccccccc-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002') order by name;
select '세트 재고(0)' as t, stock_quantity from public.products where name='삼겹살+목살 실속세트';

select '--- N13: 출고 스캔으로 세트 박스를 찍을 수 있다 (자체 세트번호) ---' as t;
select (public.record_outbound_scan(
    'eeeeeeee-0000-0000-0000-000000000001',
    (select set_no from public.bundle_assemblies order by set_no limit 1)))
    - 'product_id' - 'trace_part' - 'product_part' as result;

select '--- N14: 이력번호 역추적 — 이 번호가 어느 세트로 누구에게 갔나 ---' as t;
select trace_no, set_no, component_name, used_weight, assembly_status, order_number, retailer_name
  from public.trace_bundle_usage('002111111111');

select '--- N15: 중첩 세트 금지 ---' as t;
do $$
declare v_set uuid;
begin
  select product_id into v_set from public.product_bundles;
  perform public.save_product_bundle(
    ('[{"product_id":"' || v_set || '","quantity":1}]')::jsonb,
    null, null, '세트의 세트', 90000, null, null);
  raise notice 'FAIL: 막히지 않음';
exception when others then raise notice 'PASS: %', sqlerrm;
end $$;

select '--- N16: 입출고 기록이 있는 상품은 세트로 지정할 수 없다 ---' as t;
do $$ begin
  perform public.save_product_bundle(
    '[{"product_id":"cccccccc-0000-0000-0000-000000000002","quantity":1}]'::jsonb,
    null, 'cccccccc-0000-0000-0000-000000000001', null, null, null, null);
  raise notice 'FAIL: 막히지 않음';
exception when others then raise notice 'PASS: %', sqlerrm;
end $$;

select '--- N17: 제작 이력이 있는 세트 구성은 지울 수 없다 ---' as t;
do $$ begin
  perform public.delete_product_bundle((select id from public.product_bundles));
  raise notice 'FAIL: 막히지 않음';
exception when others then raise notice 'PASS: %', sqlerrm;
end $$;

select '--- N18: 세트 상품의 단위는 kg으로 되돌릴 수 없다 (트리거) ---' as t;
reset role;
update public.products set unit='kg' where id=(select product_id from public.product_bundles);
select unit as should_be_set from public.products where id=(select product_id from public.product_bundles);
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select '--- N19: 테넌트 격리 — B사는 세트도 제작건도 0건 ---' as t;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select (select count(*) from public.list_product_bundles()) as bundles_should_be_0,
       (select count(*) from public.list_bundle_assemblies()) as assemblies_should_be_0,
       (select count(*) from public.trace_bundle_usage('002111111111')) as traces_should_be_0;

reset role;
