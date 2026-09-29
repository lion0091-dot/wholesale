-- 입고 연결 ① — 마이그레이션 142 검증(거래처 실린 스캔 → 발주서 줄 판정·거절 기록·자동 마감). 로컬 Docker DB 전용, 끝에서 자기 데이터를 지운다.
-- 실행: docker exec -i supabase_db_wholesale psql -U postgres -v ON_ERROR_STOP=1 < scripts/db-test-purchase-order-receiving.sql
-- 각 검증은 "PASS: ..." / 실패 시 예외로 멈춘다.
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then
        raise exception 'FAIL: %', p_name;
    end if;
    raise notice 'PASS: %', p_name;
end $$;

-- ---------------------------------------------------------------- 준비 (슈퍼유저)
insert into auth.users (id, email) values
    ('d2d2d2d2-0000-0000-0000-000000000001', 'po-recv-a@t.com'),
    ('d2d2d2d2-0000-0000-0000-000000000002', 'po-recv-b@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values
    ('d2d2d2d2-0000-0000-0000-000000000001', 'wholesaler', 'A', '010'),
    ('d2d2d2d2-0000-0000-0000-000000000002', 'wholesaler', 'B', '010')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name) values
    ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-000000000001', '입고연결A', '1110000201', 'A'),
    ('d2d2d2d2-0000-0000-0000-0000000000a2', 'd2d2d2d2-0000-0000-0000-000000000002', '입고연결B', '1110000202', 'B');

insert into public.suppliers (id, wholesaler_id, name) values
    ('d2d2d2d2-0000-0000-0000-0000000005a1', 'd2d2d2d2-0000-0000-0000-0000000000a1', '공급처가'),
    ('d2d2d2d2-0000-0000-0000-0000000005a2', 'd2d2d2d2-0000-0000-0000-0000000000a1', '공급처나'),
    ('d2d2d2d2-0000-0000-0000-0000000005b1', 'd2d2d2d2-0000-0000-0000-0000000000a2', '남의 공급처');

-- 상품 P1..P8 (소 한우, 부위만 다르게). id는 ...00c1 ~ ...00c8
insert into public.products (id, wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit) values
    ('d2d2d2d2-0000-0000-0000-0000000000c1', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 등심 1++', '소', '등심',   '1++', '국내산', '한우', 0, 'kg'),
    ('d2d2d2d2-0000-0000-0000-0000000000c2', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 채끝 1++', '소', '채끝',   '1++', '국내산', '한우', 0, 'kg'),
    ('d2d2d2d2-0000-0000-0000-0000000000c3', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 안심 1++', '소', '안심',   '1++', '국내산', '한우', 0, 'kg'),
    ('d2d2d2d2-0000-0000-0000-0000000000c4', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 목심 1++', '소', '목심',   '1++', '국내산', '한우', 0, 'kg'),
    ('d2d2d2d2-0000-0000-0000-0000000000c5', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 앞다리 1++', '소', '앞다리', '1++', '국내산', '한우', 0, 'kg'),
    ('d2d2d2d2-0000-0000-0000-0000000000c6', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 갈비 1++', '소', '갈비',   '1++', '국내산', '한우', 0, 'kg'),
    ('d2d2d2d2-0000-0000-0000-0000000000c7', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 양지 1++', '소', '양지',   '1++', '국내산', '한우', 0, 'kg');

-- 발주서(모두 공급처가, OPEN). 작성 시각 순서를 뚜렷하게 하려고 문장을 나눠 넣는다.
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000b01', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date - 5, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000f101', 'd2d2d2d2-0000-0000-0000-000000000b01', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '등심', '1++', '국내산', '한우', 50, 'd2d2d2d2-0000-0000-0000-0000000000c1'),
    ('d2d2d2d2-0000-0000-0000-00000000f102', 'd2d2d2d2-0000-0000-0000-000000000b01', 'd2d2d2d2-0000-0000-0000-0000000000a1', 2, '소', '채끝', '1++', '국내산', '한우', 10, 'd2d2d2d2-0000-0000-0000-0000000000c2');

insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000b02', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date - 4, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000f201', 'd2d2d2d2-0000-0000-0000-000000000b02', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '목심', '1++', '국내산', '한우', 10, 'd2d2d2d2-0000-0000-0000-0000000000c4'),
    ('d2d2d2d2-0000-0000-0000-00000000f202', 'd2d2d2d2-0000-0000-0000-000000000b02', 'd2d2d2d2-0000-0000-0000-0000000000a1', 2, '소', '앞다리', '1++', '국내산', '한우', 100, 'd2d2d2d2-0000-0000-0000-0000000000c5');

-- 목심(P4)은 서로 다른 발주서 두 곳에 각각 10kg (후보가 여럿인 경우)
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000b03', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date - 3, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000f301', 'd2d2d2d2-0000-0000-0000-000000000b03', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '목심', '1++', '국내산', '한우', 10, 'd2d2d2d2-0000-0000-0000-0000000000c4'),
    ('d2d2d2d2-0000-0000-0000-00000000f302', 'd2d2d2d2-0000-0000-0000-000000000b03', 'd2d2d2d2-0000-0000-0000-0000000000a1', 2, '소', '양지', '1++', '국내산', '한우', 10, 'd2d2d2d2-0000-0000-0000-0000000000c7');

-- 다른 업체 발주서(격리 확인용)
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000b99', 'd2d2d2d2-0000-0000-0000-0000000000a2', 'd2d2d2d2-0000-0000-0000-0000000005b1', '남의 공급처', current_date, 'OPEN');

grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date,text,text) to authenticated;

-- ---------------------------------------------------------------- 도우미 (A 세션으로 전환)
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';

create or replace function pg_temp.scan(p_trace text, p_weight numeric, p_product uuid, p_supplier uuid)
returns jsonb language plpgsql as $$
begin
    perform public.upsert_master_livestock(p_trace, 'individual', 'mtrace_livestock', '{}'::jsonb, '한우', '소', '등심', '1++', current_date - 3, '○○도축장');
    return public.record_inbound_scan(
        p_trace_no => p_trace, p_weight => p_weight, p_scan_type => 'BARCODE_SCAN',
        p_product_id => p_product, p_supplier_id => p_supplier);
end $$;

-- ---------------------------------------------------------------- 1) 기본 배정·받은 양·남은 양
select pg_temp.scan('009800000001', 20, 'd2d2d2d2-0000-0000-0000-0000000000c1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('20kg → ASSIGNED, 남은 30, 등심 줄에 20kg 채워짐',
    (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED' and ((:'r'::jsonb) #>> '{po,remaining}')::numeric = 30
    and (select x.weight = 20 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id
         where s.trace_no = '009800000001' and x.line_id = 'd2d2d2d2-0000-0000-0000-00000000f101'));
select pg_temp.expect('스캔에 거래처·판정 상태가 기록되고 입고 상태는 NORMAL, 매입처 이름이 거래처 이름으로 채워짐',
    (select supplier_id = 'd2d2d2d2-0000-0000-0000-0000000005a1' and po_state = 'ASSIGNED' and status = 'NORMAL' and purchase_supplier = '공급처가'
       from public.inbound_scans where trace_no = '009800000001'));

-- 2) 멱등: 같은 박스를 다시 판정해도 다시 세지 않는다
select public.judge_scan_purchase_order((select id from public.inbound_scans where trace_no = '009800000001')) as r2 \gset
select pg_temp.expect('재판정은 결과만 돌려줌(ASSIGNED, 채움 그대로)',
    (:'r2'::jsonb) ->> 'result' = 'ASSIGNED' and (select count(*) from public.purchase_order_line_scans) = 1
    and ((:'r2'::jsonb) ->> 'received')::numeric = 20);

-- 3) 나머지 30kg → 등심 줄 참 (발주서는 채끝 줄이 남아 아직 안 닫힘)
select pg_temp.scan('009800000002', 30, 'd2d2d2d2-0000-0000-0000-0000000000c1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('30kg → ASSIGNED, 남은 0, 발주서는 아직 열려 있음',
    (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED' and ((:'r'::jsonb) #>> '{po,remaining}')::numeric = 0
    and (select status = 'OPEN' from public.purchase_orders where id = 'd2d2d2d2-0000-0000-0000-000000000b01'));

-- 4) 초과 → 거절, 재고 무변화, 거절 기록
select pg_temp.scan('009800000003', 0.5, 'd2d2d2d2-0000-0000-0000-0000000000c1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('0.5kg 초과 → REJECTED(OVER), 응답 status도 REJECTED',
    (:'r'::jsonb) #>> '{po,result}' = 'REJECTED' and (:'r'::jsonb) #>> '{po,reason}' = 'OVER' and (:'r'::jsonb) ->> 'status' = 'REJECTED');
select pg_temp.expect('거절된 박스는 재고에 안 잡히고(50 유지) 스캔은 VOIDED, 거절 기록이 한 줄 남음',
    (select stock_quantity = 50 from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000c1')
    and (select status = 'VOIDED' from public.inbound_scans where trace_no = '009800000003')
    and (select count(*) = 1 and min(reason) = 'OVER' and min(weight) = 0.5 from public.inbound_rejections where trace_no = '009800000003'));

-- 5) 마지막 줄을 채우면 발주서 자동 마감
select pg_temp.scan('009800000004', 10, 'd2d2d2d2-0000-0000-0000-0000000000c2', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('채끝 10kg → 모든 줄 참 → order_closed, 발주서 CLOSED + auto_closed_at',
    ((:'r'::jsonb) #>> '{po,order_closed}')::boolean
    and (select status = 'CLOSED' and auto_closed_at is not null from public.purchase_orders where id = 'd2d2d2d2-0000-0000-0000-000000000b01'));

-- 6) 박스를 취소하면 줄에서 떨어지고 자동 마감됐던 발주서가 다시 열림
select public.void_inbound_scan((select id from public.inbound_scans where trace_no = '009800000004'), '테스트 취소');
select pg_temp.expect('박스 취소 → 발주서 다시 OPEN, 연결 사라짐',
    (select status = 'OPEN' and auto_closed_at is null from public.purchase_orders where id = 'd2d2d2d2-0000-0000-0000-000000000b01')
    and not exists (select 1 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000004'));

-- 7) 사람이 닫은 발주서는 박스를 취소해도 안 열림
reset role;
update public.purchase_orders set status = 'CLOSED' where id = 'd2d2d2d2-0000-0000-0000-000000000b01';
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';
select public.void_inbound_scan((select id from public.inbound_scans where trace_no = '009800000002'), '테스트 취소2');
select pg_temp.expect('사람이 닫은 발주서는 그대로 CLOSED',
    (select status = 'CLOSED' from public.purchase_orders where id = 'd2d2d2d2-0000-0000-0000-000000000b01'));

-- 8) 발주서에 없는 물건(기본 REJECT)
select pg_temp.scan('009800000005', 5, 'd2d2d2d2-0000-0000-0000-0000000000c3', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('안심(발주서에 없음) → REJECTED(UNLISTED) + 기록',
    (:'r'::jsonb) #>> '{po,reason}' = 'UNLISTED'
    and (select count(*) = 1 from public.inbound_rejections where trace_no = '009800000005' and reason = 'UNLISTED'));

-- 8-2) 사람이 닫은 발주서(b01)의 품목(등심)이 또 오면: 다 받은 게 아니니 "없는 물건" 기준(REJECT)
select pg_temp.scan('009800000020', 2, 'd2d2d2d2-0000-0000-0000-0000000000c1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('사람이 닫은 발주서의 품목 → UNLISTED', (:'r'::jsonb) #>> '{po,reason}' = 'UNLISTED');

-- 9) 다른 거래처로 온 박스는 남의 발주서에 붙지 않는다(공급처나에는 발주서 없음)
select pg_temp.scan('009800000006', 5, 'd2d2d2d2-0000-0000-0000-0000000000c4', 'd2d2d2d2-0000-0000-0000-0000000005a2') as r \gset
select pg_temp.expect('공급처나 → 목심 발주 없음 → 거절(거래처별 격리)', (:'r'::jsonb) #>> '{po,result}' = 'REJECTED');

-- 10) 없는 물건 HOLD 기준: 받아 두고 보류
insert into public.receiving_policies (wholesaler_id, unlisted_item_policy) values ('d2d2d2d2-0000-0000-0000-0000000000a1', 'HOLD');
select pg_temp.scan('009800000007', 5, 'd2d2d2d2-0000-0000-0000-0000000000c3', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('HOLD → UNLISTED_HELD, 박스는 NORMAL로 받고 재고 5, 거절 기록 없음',
    (:'r'::jsonb) #>> '{po,result}' = 'UNLISTED_HELD'
    and (select status = 'NORMAL' and po_state = 'UNLISTED_HELD' from public.inbound_scans where trace_no = '009800000007')
    and (select stock_quantity = 5 from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000c3')
    and not exists (select 1 from public.inbound_rejections where trace_no = '009800000007'));

-- 11) 허용 오차 비율(PERCENT 10): 앞다리 100kg → 110까지 허용
update public.receiving_policies set over_tolerance_mode = 'PERCENT', over_tolerance_value = 10 where wholesaler_id = 'd2d2d2d2-0000-0000-0000-0000000000a1';
select pg_temp.scan('009800000008', 105, 'd2d2d2d2-0000-0000-0000-0000000000c5', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('105kg(≤110) → ASSIGNED', (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED');
select pg_temp.scan('009800000009', 6, 'd2d2d2d2-0000-0000-0000-0000000000c5', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('+6kg → 111 > 110 → REJECTED(OVER), 허용 오차 10 기록',
    (:'r'::jsonb) #>> '{po,reason}' = 'OVER' and ((:'r'::jsonb) #>> '{po,tolerance}')::numeric = 10);

-- 12) 허용 오차 kg(KG 2): 이미 찬 등심 줄이 아니라 갈비(P6)용 새 발주서로
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000b04', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000f401', 'd2d2d2d2-0000-0000-0000-000000000b04', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '갈비', '1++', '국내산', '한우', 10, 'd2d2d2d2-0000-0000-0000-0000000000c6');
update public.receiving_policies set over_tolerance_mode = 'KG', over_tolerance_value = 2 where wholesaler_id = 'd2d2d2d2-0000-0000-0000-0000000000a1';
select pg_temp.scan('009800000010', 11.5, 'd2d2d2d2-0000-0000-0000-0000000000c6', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('KG 2 → 11.5kg(≤12) → ASSIGNED', (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED');
select pg_temp.scan('009800000011', 1, 'd2d2d2d2-0000-0000-0000-0000000000c6', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('+1kg → 12.5 > 12 → REJECTED', (:'r'::jsonb) #>> '{po,reason}' = 'OVER');

-- 13) 같은 물건이 열린 발주서 두 곳에 있으면(목심: 발주서 b02 10kg + b03 10kg) 하나의 묶음으로 본다 — 오래된 발주서부터 채운다
update public.receiving_policies set over_tolerance_mode = 'PERCENT', over_tolerance_value = 0 where wholesaler_id = 'd2d2d2d2-0000-0000-0000-0000000000a1';
select pg_temp.scan('009800000012', 3, 'd2d2d2d2-0000-0000-0000-0000000000c4', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('3kg → 오래된 발주서(b02)의 줄 f201에 채워짐',
    (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED'
    and (select count(*) = 1 and min(x.line_id::text) = 'd2d2d2d2-0000-0000-0000-00000000f201' and min(x.weight) = 3
         from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000012'));

select pg_temp.scan('009800000013', 18, 'd2d2d2d2-0000-0000-0000-0000000000c4', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('두 발주서 합계(20kg)를 넘는 박스(3+18) → REJECTED(OVER)', (:'r'::jsonb) #>> '{po,reason}' = 'OVER');

-- 박스 하나가 앞 발주서의 남은 자리(7kg)를 채우고 나머지(10kg)는 다음 발주서로 나뉜다
select pg_temp.scan('009800000014', 17, 'd2d2d2d2-0000-0000-0000-0000000000c4', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('17kg → f201에 7kg + f301에 10kg으로 나뉘어 채워지고 두 줄 합계가 발주 20·받음 20',
    (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED'
    and ((:'r'::jsonb) #>> '{po,ordered}')::numeric = 20 and ((:'r'::jsonb) #>> '{po,received}')::numeric = 20
    and (select count(*) = 2 and sum(x.weight) = 17 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000014')
    and (select x.weight = 7 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000014' and x.line_id = 'd2d2d2d2-0000-0000-0000-00000000f201')
    and (select x.weight = 10 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000014' and x.line_id = 'd2d2d2d2-0000-0000-0000-00000000f301'));

-- 14) 줄이 다 찬 발주서만 자동 마감: b02(목심·앞다리 모두 참)는 닫히고 b03(양지가 아직)은 열려 있다
select pg_temp.expect('b02 자동 마감, b03은 양지가 남아 열려 있음',
    (select status = 'CLOSED' and auto_closed_at is not null from public.purchase_orders where id = 'd2d2d2d2-0000-0000-0000-000000000b02')
    and (select status = 'OPEN' from public.purchase_orders where id = 'd2d2d2d2-0000-0000-0000-000000000b03'));

-- 15) 사장님 시나리오: 같은 거래처·같은 물건, 발주서 200kg와 25kg 두 장. 70kg·80kg 박스가 먼저 오고 나중에 77kg 박스가 온다(합계 227 vs 발주 225)
reset role;
insert into public.products (id, wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit) values
    ('d2d2d2d2-0000-0000-0000-0000000000c9', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 사태 1++', '소', '사태', '1++', '국내산', '한우', 0, 'kg');
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000ba1', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date - 2, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000fa01', 'd2d2d2d2-0000-0000-0000-000000000ba1', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '사태', '1++', '국내산', '한우', 200, 'd2d2d2d2-0000-0000-0000-0000000000c9');
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000ba2', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date - 1, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000fa02', 'd2d2d2d2-0000-0000-0000-000000000ba2', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '사태', '1++', '국내산', '한우', 25, 'd2d2d2d2-0000-0000-0000-0000000000c9');
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';

select pg_temp.scan('009800000021', 70, 'd2d2d2d2-0000-0000-0000-0000000000c9', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.scan('009800000022', 80, 'd2d2d2d2-0000-0000-0000-0000000000c9', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('70kg+80kg → 오래된 200kg 발주서에 150 채워짐, 두 발주서 모두 열려 있고 재고는 이미 150(판매 가능)',
    (select sum(x.weight) = 150 and count(distinct x.line_id) = 1 and min(x.line_id::text) = 'd2d2d2d2-0000-0000-0000-00000000fa01' from public.purchase_order_line_scans x where x.line_id in ('d2d2d2d2-0000-0000-0000-00000000fa01', 'd2d2d2d2-0000-0000-0000-00000000fa02'))
    and (select bool_and(status = 'OPEN') from public.purchase_orders where id in ('d2d2d2d2-0000-0000-0000-000000000ba1', 'd2d2d2d2-0000-0000-0000-000000000ba2'))
    and (select stock_quantity = 150 from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000c9')
    and (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED');

-- 허용 오차 0: 77kg → 150+77=227 > 225 → 거절
select pg_temp.scan('009800000023', 77, 'd2d2d2d2-0000-0000-0000-0000000000c9', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('오차 0에서 77kg 박스(합계 227 > 225) → REJECTED(OVER)', (:'r'::jsonb) #>> '{po,reason}' = 'OVER');

-- 허용 오차 kg 3: 77kg 박스가 앞 발주서 남은 50을 채우고 나머지 27은 25kg 발주서(25)+초과 2로 — 두 발주서가 함께 닫힌다
update public.receiving_policies set over_tolerance_mode = 'KG', over_tolerance_value = 3 where wholesaler_id = 'd2d2d2d2-0000-0000-0000-0000000000a1';
select pg_temp.scan('009800000024', 77, 'd2d2d2d2-0000-0000-0000-0000000000c9', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('오차 KG 3에서 77kg → 200kg 발주서 50 + 25kg 발주서 27(초과 2 포함), 두 발주서 자동 마감',
    (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED' and ((:'r'::jsonb) #>> '{po,order_closed}')::boolean
    and (select x.weight = 50 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000024' and x.line_id = 'd2d2d2d2-0000-0000-0000-00000000fa01')
    and (select x.weight = 27 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000024' and x.line_id = 'd2d2d2d2-0000-0000-0000-00000000fa02')
    and (select bool_and(status = 'CLOSED' and auto_closed_at is not null) from public.purchase_orders where id in ('d2d2d2d2-0000-0000-0000-000000000ba1', 'd2d2d2d2-0000-0000-0000-000000000ba2'))
    and (select stock_quantity = 227 from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000c9'));

-- 마지막 박스를 취소하면 두 발주서가 함께 다시 열린다
select public.void_inbound_scan((select id from public.inbound_scans where trace_no = '009800000024'), '테스트 취소3');
select pg_temp.expect('77kg 박스 취소 → 두 발주서 모두 다시 OPEN',
    (select bool_and(status = 'OPEN' and auto_closed_at is null) from public.purchase_orders where id in ('d2d2d2d2-0000-0000-0000-000000000ba1', 'd2d2d2d2-0000-0000-0000-000000000ba2')));

-- 덜 온 채로 끝나도(150kg만 옴) 발주서는 열려 있을 뿐 재고·판매에는 아무 제약이 없다(위에서 재고 150 확인)

-- 배정 오류 함수는 없어졌다
select pg_temp.expect('사무실 배정 함수는 더 이상 없다',
    not exists (select 1 from pg_proc where proname = 'assign_scan_to_purchase_order_line' and pronamespace = 'public'::regnamespace));

update public.receiving_policies set over_tolerance_mode = 'PERCENT', over_tolerance_value = 0 where wholesaler_id = 'd2d2d2d2-0000-0000-0000-0000000000a1';

-- 16) 상품이 나중에 정해지는 경로: 미매핑 박스 → 지정하는 순간 판정, 초과면 거절
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status)
    select 'd2d2d2d2-0000-0000-0000-000000000b05', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date, 'OPEN'
    where false;
reset role;
insert into public.products (id, wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit) values
    ('d2d2d2d2-0000-0000-0000-0000000000c8', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 우둔 1++', '소', '우둔', '1++', '국내산', '한우', 0, 'kg');
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000b05', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000f501', 'd2d2d2d2-0000-0000-0000-000000000b05', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '우둔', '1++', '국내산', '한우', 10, 'd2d2d2d2-0000-0000-0000-0000000000c8');
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';

select public.upsert_master_livestock('009800000015', 'individual', 'mtrace_livestock', '{}'::jsonb, '한우', '소', '우둔', '1++', current_date - 3, '○○도축장');
select public.record_inbound_scan(p_trace_no => '009800000015', p_weight => 8, p_scan_type => 'BARCODE_SCAN', p_supplier_id => 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('상품 미지정 박스는 PENDING_MAPPING, 판정 안 함(po_state NULL, 응답에 po 없음)',
    (:'r'::jsonb) ->> 'status' = 'PENDING_MAPPING' and not ((:'r'::jsonb) ? 'po')
    and (select supplier_id is not null and po_state is null from public.inbound_scans where trace_no = '009800000015'));
select public.resolve_inbound_mapping((select id from public.inbound_scans where trace_no = '009800000015'), 'd2d2d2d2-0000-0000-0000-0000000000c8', false) as r \gset
select pg_temp.expect('상품 지정 → 그 순간 판정(ASSIGNED, 남은 2), status NORMAL',
    (:'r'::jsonb) ->> 'status' = 'NORMAL' and (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED' and ((:'r'::jsonb) #>> '{po,remaining}')::numeric = 2);

select public.upsert_master_livestock('009800000016', 'individual', 'mtrace_livestock', '{}'::jsonb, '한우', '소', '우둔', '1++', current_date - 3, '○○도축장');
select public.record_inbound_scan(p_trace_no => '009800000016', p_weight => 5, p_scan_type => 'BARCODE_SCAN', p_supplier_id => 'd2d2d2d2-0000-0000-0000-0000000005a1');
select public.resolve_inbound_mapping((select id from public.inbound_scans where trace_no = '009800000016'), 'd2d2d2d2-0000-0000-0000-0000000000c8', false) as r \gset
select pg_temp.expect('지정 시점에 초과면 status REJECTED, 스캔 VOIDED, 거절 기록',
    (:'r'::jsonb) ->> 'status' = 'REJECTED'
    and (select status = 'VOIDED' from public.inbound_scans where trace_no = '009800000016')
    and (select count(*) = 1 from public.inbound_rejections where trace_no = '009800000016'));

select public.upsert_master_livestock('009800000017', 'individual', 'mtrace_livestock', '{}'::jsonb, '한우', '소', '우둔', '1++', current_date - 3, '○○도축장');
select public.record_inbound_scan(p_trace_no => '009800000017', p_weight => 5, p_scan_type => 'BARCODE_SCAN', p_supplier_id => 'd2d2d2d2-0000-0000-0000-0000000005a1');
select public.resolve_inbound_mapping_to_order((select id from public.inbound_scans where trace_no = '009800000017'), 'd2d2d2d2-0000-0000-0000-0000000000c8', 'd2d2d2d2-0000-0000-0000-000000000d99', false) as r \gset
select pg_temp.expect('주문 바로 출고 경로: 거절이면 출고를 건너뛰고(outbound null) 예외 없이 돌려줌',
    (:'r'::jsonb) #>> '{resolve,status}' = 'REJECTED' and (:'r'::jsonb) -> 'outbound' = 'null'::jsonb);

-- 17) 거래처를 안 실은 스캔은 옛 동작 그대로(판정 없음)
select public.upsert_master_livestock('009800000018', 'individual', 'mtrace_livestock', '{}'::jsonb, '한우', '소', '등심', '1++', current_date - 3, '○○도축장');
select public.record_inbound_scan(p_trace_no => '009800000018', p_weight => 500, p_scan_type => 'BARCODE_SCAN', p_product_id => 'd2d2d2d2-0000-0000-0000-0000000000c1') as r \gset
select pg_temp.expect('거래처 없는 스캔은 판정·제한 없음(500kg도 받음)',
    (:'r'::jsonb) ->> 'status' = 'NORMAL' and not ((:'r'::jsonb) ? 'po')
    and (select supplier_id is null and po_state is null from public.inbound_scans where trace_no = '009800000018'));

-- 18) 남의 거래처 ID / 없는 거래처
do $$
declare v_ok boolean;
begin
    v_ok := false;
    begin
        perform pg_temp.scan('009800000019', 1, 'd2d2d2d2-0000-0000-0000-0000000000c1', 'd2d2d2d2-0000-0000-0000-0000000005b1');
    exception when others then v_ok := sqlerrm like '%SUPPLIER_NOT_FOUND%'; end;
    perform pg_temp.expect('다른 업체의 거래처 ID → SUPPLIER_NOT_FOUND', v_ok);
end $$;

-- 18-2) 초과도 일단 받기(over_item_policy = HOLD): 재고에 들어가 팔 수 있고, 발주서엔 남은 자리만 채우며, 거절 기록은 안 남는다
reset role;
insert into public.products (id, wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit) values
    ('d2d2d2d2-0000-0000-0000-0000000000d1', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 설도 1++', '소', '설도', '1++', '국내산', '한우', 0, 'kg');
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000b06', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000f601', 'd2d2d2d2-0000-0000-0000-000000000b06', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '설도', '1++', '국내산', '한우', 10, 'd2d2d2d2-0000-0000-0000-0000000000d1');
update public.receiving_policies set over_tolerance_mode = 'PERCENT', over_tolerance_value = 0, over_item_policy = 'REJECT' where wholesaler_id = 'd2d2d2d2-0000-0000-0000-0000000000a1';
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';

select pg_temp.scan('009800000031', 6, 'd2d2d2d2-0000-0000-0000-0000000000d1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('기준 REJECT(기본): 6kg는 받고 발주 10kg 중 남음 4', (:'r'::jsonb) #>> '{po,result}' = 'ASSIGNED');
select pg_temp.scan('009800000032', 7, 'd2d2d2d2-0000-0000-0000-0000000000d1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('기준 REJECT: 초과 7kg은 그대로 거절',
    (:'r'::jsonb) #>> '{po,result}' = 'REJECTED' and (:'r'::jsonb) ->> 'status' = 'REJECTED'
    and (select stock_quantity = 6 from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000d1'));

reset role;
update public.receiving_policies set over_item_policy = 'HOLD' where wholesaler_id = 'd2d2d2d2-0000-0000-0000-0000000000a1';
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';

select pg_temp.scan('009800000033', 7, 'd2d2d2d2-0000-0000-0000-0000000000d1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('기준 HOLD: 7kg → OVER_HELD, 박스는 NORMAL로 받아 재고 13, 응답 status는 REJECTED가 아님, 넘친 무게 3kg',
    (:'r'::jsonb) #>> '{po,result}' = 'OVER_HELD' and (:'r'::jsonb) ->> 'status' is distinct from 'REJECTED'
    and ((:'r'::jsonb) #>> '{po,excess}')::numeric = 3
    and (select status = 'NORMAL' and po_state = 'OVER_HELD' from public.inbound_scans where trace_no = '009800000033')
    and (select stock_quantity = 13 from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000d1')
    and not exists (select 1 from public.inbound_rejections where trace_no = '009800000033'));
select pg_temp.expect('발주서 줄엔 남은 자리 4kg만 채워지고(넘친 3kg는 안 붙음), 줄이 다 차서 발주서 자동 마감',
    (select count(*) = 1 and sum(x.weight) = 4 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000033')
    and (select status = 'CLOSED' and auto_closed_at is not null from public.purchase_orders where id = 'd2d2d2d2-0000-0000-0000-000000000b06'));

select pg_temp.scan('009800000034', 5, 'd2d2d2d2-0000-0000-0000-0000000000d1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('이미 다 받아 자동 마감된 발주서의 품목이 또 와도 HOLD면 받아 둠(열린 줄이 없어도 오류 없이 채움 0)',
    (:'r'::jsonb) #>> '{po,result}' = 'OVER_HELD'
    and (select status = 'NORMAL' and po_state = 'OVER_HELD' from public.inbound_scans where trace_no = '009800000034')
    and not exists (select 1 from public.purchase_order_line_scans x join public.inbound_scans s on s.id = x.scan_id where s.trace_no = '009800000034')
    and (select stock_quantity = 18 from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000d1'));
select pg_temp.expect('이미 마감된 발주서 초과분도 ordered/received가 0/0이 아니라 실제 수량(발주 10 중 10 이미 받음)으로 표시',
    ((:'r'::jsonb) #>> '{po,ordered}')::numeric = 10 and ((:'r'::jsonb) #>> '{po,received}')::numeric = 10
    and ((:'r'::jsonb) #>> '{po,excess}')::numeric = 5);
select pg_temp.expect('OVER_HELD 판정 수치는 po_detail에 저장돼 나중에 다시 읽을 수 있다',
    (select po_detail = jsonb_build_object('ordered', 10, 'received', 10, 'remaining', 0, 'tolerance', 0, 'excess', 5)
     from public.inbound_scans where trace_no = '009800000034'));

-- 146: 이미 판정된 OVER_HELD 박스를 같은 함수로 다시 조회(멱등 경로)해도 방금 저장한 실제 수치가 유지돼야 한다
-- (purchase_order_scan_progress가 뒤에서 0/0/0으로 덮어쓰던 버그, 145 배포 직후 발견).
select public.judge_scan_purchase_order((select id from public.inbound_scans where trace_no = '009800000034')) as r \gset
select pg_temp.expect('146: OVER_HELD 박스 재조회(멱등)해도 ordered/received/excess가 0으로 덮이지 않는다',
    ((:'r'::jsonb) ->> 'result') = 'OVER_HELD'
    and ((:'r'::jsonb) ->> 'ordered')::numeric = 10 and ((:'r'::jsonb) ->> 'received')::numeric = 10
    and ((:'r'::jsonb) ->> 'excess')::numeric = 5);

-- 148: 같은 거래처·상품으로 자동 마감된 발주서가 여러 건이면 합치지 말고 가장 최근 것 하나만 봐야 한다
reset role;
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status, auto_closed_at) values
    ('d2d2d2d2-0000-0000-0000-000000000b07', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date - 30, 'CLOSED', current_date - 29);
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000f701', 'd2d2d2d2-0000-0000-0000-000000000b07', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '설도', '1++', '국내산', '한우', 20, 'd2d2d2d2-0000-0000-0000-0000000000d1');
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';

select pg_temp.scan('009800000035', 5, 'd2d2d2d2-0000-0000-0000-0000000000d1', 'd2d2d2d2-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('148: 예전에 마감된 발주서(20kg, 못 받은 채)와 최근 마감(10kg 다 받음)이 둘 다 있어도 합쳐서 30이 아니라 최근 것(10) 기준',
    ((:'r'::jsonb) #>> '{po,result}') = 'OVER_HELD'
    and ((:'r'::jsonb) #>> '{po,ordered}')::numeric = 10 and ((:'r'::jsonb) #>> '{po,received}')::numeric = 10);

select public.void_inbound_scan((select id from public.inbound_scans where trace_no = '009800000033' and status = 'NORMAL' limit 1), '테스트 취소3');
select pg_temp.expect('OVER_HELD 박스 취소 → 채움이 사라지고 자동 마감됐던 발주서 다시 OPEN',
    (select status = 'OPEN' and auto_closed_at is null from public.purchase_orders where id = 'd2d2d2d2-0000-0000-0000-000000000b06'));

-- 147: 상품 삭제는 열린(OPEN) 발주서 줄이 있으면 트리거가 막는다(앱 쪽 확인과 삭제 사이의 틈을 노려도 DB가 막음)
reset role;
insert into public.products (id, wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit) values
    ('d2d2d2d2-0000-0000-0000-0000000000e1', 'd2d2d2d2-0000-0000-0000-0000000000a1', '한우 차돌박이 1++', '소', '차돌박이', '1++', '국내산', '한우', 0, 'kg');
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('d2d2d2d2-0000-0000-0000-000000000b08', 'd2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000005a1', '공급처가', current_date, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('d2d2d2d2-0000-0000-0000-00000000f801', 'd2d2d2d2-0000-0000-0000-000000000b08', 'd2d2d2d2-0000-0000-0000-0000000000a1', 1, '소', '차돌박이', '1++', '국내산', '한우', 10, 'd2d2d2d2-0000-0000-0000-0000000000e1');
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';

do $$
declare v_ok boolean;
begin
    v_ok := false;
    begin
        delete from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000e1';
    exception when others then v_ok := sqlerrm like '%PRODUCT_HAS_OPEN_PURCHASE_ORDER_LINE%'; end;
    perform pg_temp.expect('147: 열린 발주서 줄이 있는 상품 삭제 → 트리거가 막음', v_ok);
end $$;

reset role;
update public.purchase_orders set status = 'CLOSED' where id = 'd2d2d2d2-0000-0000-0000-000000000b08';
set role authenticated;
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';
delete from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000e1';
select pg_temp.expect('147: 발주서가 닫히면 그 상품은 삭제할 수 있다', not exists (select 1 from public.products where id = 'd2d2d2d2-0000-0000-0000-0000000000e1'));

-- 19) 격리: B 업체 세션은 A의 거절 기록·연결을 못 본다
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000002';
select pg_temp.expect('B는 A의 거절 기록·발주서 연결이 0건으로 보임',
    (select count(*) from public.inbound_rejections) = 0 and (select count(*) from public.purchase_order_line_scans) = 0);
set request.jwt.claim.sub = 'd2d2d2d2-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------- 정리
reset role;
delete from public.inbound_rejections where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.purchase_order_line_scans where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.stock_ledger where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.inbound_scans where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.purchase_orders where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.trace_product_map where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.products where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.suppliers where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.receiving_policies where wholesaler_id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.wholesalers where id in ('d2d2d2d2-0000-0000-0000-0000000000a1', 'd2d2d2d2-0000-0000-0000-0000000000a2');
delete from public.master_livestock where trace_no like '0098000000%';
delete from public.profiles where id in ('d2d2d2d2-0000-0000-0000-000000000001', 'd2d2d2d2-0000-0000-0000-000000000002');
delete from auth.users where id in ('d2d2d2d2-0000-0000-0000-000000000001', 'd2d2d2d2-0000-0000-0000-000000000002');
