-- 입고 실중량 검수 + 매입금액 자동 산정 (24단계) 기능 테스트
\set ON_ERROR_STOP on

insert into auth.users (id,email) values
 ('11111111-1111-1111-1111-111111111111','a@t.com'),
 ('22222222-2222-2222-2222-222222222222','b@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values
 ('11111111-1111-1111-1111-111111111111','wholesaler','A사장','010'),
 ('22222222-2222-2222-2222-222222222222','wholesaler','B사장','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A'),
 ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','B축산','1110000002','B');
insert into public.products (id,wholesaler_id,name,category,subcategory,origin,grade,base_price,unit,stock_quantity) values
 ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','한우 등심','소','등심','국내산','1++',68000,'kg',0);

-- 테스트 전용: 실서비스에서는 service_role만 실행 가능(20260930000098). 로컬 테스트 세션에만 다시 연다.
grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.upsert_master_livestock('002111111111','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-5,'○○도축장');
select public.upsert_master_livestock('002222222222','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-4,'○○도축장');
select public.upsert_master_livestock('002333333333','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('002444444444','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-2,'○○도축장');

select '--- W1: 상품별 기본 매입단가 등록 ---' as t;
select public.set_product_purchase_price('cccccccc-0000-0000-0000-000000000001', 52000, '○○도축장');

select '--- W2: 표기 20.000 / 실측 19.800 → 오차 -1%, 허용 범위 안 ---' as t;
select jsonb_pretty(public.record_inbound_scan(
    p_trace_no => '002111111111', p_weight => 19.800, p_scan_type => 'BARCODE_SCAN',
    p_product_id => 'cccccccc-0000-0000-0000-000000000001',
    p_labeled_weight => 20.000)
  - 'scan_id' - 'species_group' - 'part_name' - 'grade' - 'slaughter_date' - 'packing_date'
  - 'master_found' - 'auto_created' - 'product_id' - 'trace_no') as result;

select '재고는 실중량 기준(19.800)' as t, stock_quantity from public.products
 where id='cccccccc-0000-0000-0000-000000000001';

select '--- W3: 표기 20.000 / 실측 19.000 → 오차 -5%, 허용 초과 경고 ---' as t;
select (public.record_inbound_scan(
    p_trace_no => '002222222222', p_weight => 19.000, p_scan_type => 'BARCODE_SCAN',
    p_product_id => 'cccccccc-0000-0000-0000-000000000001',
    p_labeled_weight => 20.000)) -> 'variance_exceeded' as should_be_true;

select '--- W4: 건별 단가가 기본단가를 이긴다 (55,000원) ---' as t;
select (public.record_inbound_scan(
    p_trace_no => '002333333333', p_weight => 10.000, p_scan_type => 'BARCODE_SCAN',
    p_product_id => 'cccccccc-0000-0000-0000-000000000001',
    p_labeled_weight => 10.000, p_purchase_unit_price => 55000,
    p_purchase_supplier => '△△산업')) -> 'purchase_amount' as should_be_550000;

select '--- W5: 표기중량이 없으면 오차 판정을 하지 않는다 ---' as t;
select (public.record_inbound_scan(
    p_trace_no => '002444444444', p_weight => 8.000, p_scan_type => 'MANUAL',
    p_product_id => 'cccccccc-0000-0000-0000-000000000001'))
    - 'scan_id' - 'trace_no' - 'product_id' - 'master_found' - 'species_group'
    - 'part_name' - 'grade' - 'slaughter_date' - 'packing_date' - 'auto_created' as result;

select '--- W6: 매입 내역 ---' as t;
select trace_no, labeled_weight, actual_weight, weight_variance, variance_ratio,
       unit_price, purchase_amount, purchase_supplier
  from public.list_inbound_purchases() order by trace_no;

select '--- W7: 기간 요약 ---' as t;
select * from public.summarize_inbound_purchases();

select '--- W8: 오차 초과 건만 보기 ---' as t;
select trace_no, weight_variance, variance_ratio
  from public.list_inbound_purchases(p_only_gap => true);

select '--- W9: 단가를 나중에 채워 넣으면 금액이 따라온다 ---' as t;
insert into public.products (id,wholesaler_id,name,category,origin,base_price,unit,stock_quantity)
 values ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','한우 채끝','소','국내산',52000,'kg',0);
select public.upsert_master_livestock('002555555555','individual','mtrace_livestock','{}'::jsonb,'한우','소','채끝','1+',current_date-1,'○○도축장');
select (public.record_inbound_scan(
    p_trace_no => '002555555555', p_weight => 7.500, p_scan_type => 'BARCODE_SCAN',
    p_product_id => 'cccccccc-0000-0000-0000-000000000002')) -> 'purchase_amount' as should_be_null;
select public.update_inbound_purchase(
    (select id from public.inbound_scans where trace_no='002555555555'),
    40000, '□□축산', true) as should_be_300000;
select '기본단가로도 저장됐나' as t, unit_price, supplier_name
  from public.product_purchase_prices where product_id='cccccccc-0000-0000-0000-000000000002';

select '--- W10: 취소된 박스는 정산에서 빠진다 ---' as t;
select public.void_inbound_scan((select id from public.inbound_scans where trace_no='002444444444'), '오스캔');
select box_count, purchase_total from public.summarize_inbound_purchases();

select '--- W11: 테넌트 격리 — B사는 0건 ---' as t;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select (select count(*) from public.list_inbound_purchases()) as rows_should_be_0,
       (select box_count from public.summarize_inbound_purchases()) as boxes_should_be_0;

select '--- W12: 남의 상품에 매입단가를 못 건다 ---' as t;
do $$ begin
  perform public.set_product_purchase_price('cccccccc-0000-0000-0000-000000000001', 1000, null);
  raise notice 'FAIL: 막히지 않음';
exception when others then raise notice 'PASS: %', sqlerrm;
end $$;

reset role;
