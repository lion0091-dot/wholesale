-- 전표 ↔ 발주서 연결(마이그레이션 143) 검증 — 보류함/전표 대조 화면의 "발주서 추가 생성", 전표 거래처 설정.
-- 로컬 Docker DB 전용, 끝에서 자기 데이터를 지운다.
-- 실행: docker exec -i supabase_db_wholesale psql -U postgres -v ON_ERROR_STOP=1 < scripts/db-test-document-purchase-order-link.sql
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then
        raise exception 'FAIL: %', p_name;
    end if;
    raise notice 'PASS: %', p_name;
end $$;

create or replace function pg_temp.expect_error(p_sql text, p_needle text, p_name text) returns void language plpgsql as $$
declare v_ok boolean := false;
begin
    begin
        execute p_sql;
    exception when others then
        v_ok := sqlerrm like '%' || p_needle || '%';
    end;
    perform pg_temp.expect(p_name, v_ok);
end $$;

-- ---------------------------------------------------------------- 준비 (슈퍼유저)
insert into auth.users (id, email) values
    ('e4e4e4e4-0000-0000-0000-000000000001', 'doc-po-owner-a@t.com'),
    ('e4e4e4e4-0000-0000-0000-000000000002', 'doc-po-manager-a@t.com'),
    ('e4e4e4e4-0000-0000-0000-000000000003', 'doc-po-staff-a@t.com'),
    ('e4e4e4e4-0000-0000-0000-000000000004', 'doc-po-owner-b@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values
    ('e4e4e4e4-0000-0000-0000-000000000001', 'wholesaler', 'A사장', '010'),
    ('e4e4e4e4-0000-0000-0000-000000000002', 'wholesaler', 'A매니저', '010'),
    ('e4e4e4e4-0000-0000-0000-000000000003', 'wholesaler', 'A직원', '010'),
    ('e4e4e4e4-0000-0000-0000-000000000004', 'wholesaler', 'B사장', '010')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name) values
    ('e4e4e4e4-0000-0000-0000-0000000000a1', 'e4e4e4e4-0000-0000-0000-000000000001', '전표발주A', '1140000201', 'A'),
    ('e4e4e4e4-0000-0000-0000-0000000000a2', 'e4e4e4e4-0000-0000-0000-000000000004', '전표발주B', '1140000202', 'B');
insert into public.organizations (id, wholesaler_id, name, business_number) values
    ('e4e4e4e4-0000-0000-0000-0000000010a1', 'e4e4e4e4-0000-0000-0000-0000000000a1', '전표발주A', '1140000201');
insert into public.organization_staff (organization_id, user_id, role) values
    ('e4e4e4e4-0000-0000-0000-0000000010a1', 'e4e4e4e4-0000-0000-0000-000000000002', 'manager'),
    ('e4e4e4e4-0000-0000-0000-0000000010a1', 'e4e4e4e4-0000-0000-0000-000000000003', 'staff');

insert into public.suppliers (id, wholesaler_id, name) values
    ('e4e4e4e4-0000-0000-0000-0000000005a1', 'e4e4e4e4-0000-0000-0000-0000000000a1', '공급처가'),
    ('e4e4e4e4-0000-0000-0000-0000000005b1', 'e4e4e4e4-0000-0000-0000-0000000000a2', '남의 공급처');

insert into public.products (id, wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit) values
    ('e4e4e4e4-0000-0000-0000-0000000000c1', 'e4e4e4e4-0000-0000-0000-0000000000a1', '한우 등심 1++', '소', '등심', '1++', '국내산', '한우', 0, 'kg'),
    ('e4e4e4e4-0000-0000-0000-0000000000c2', 'e4e4e4e4-0000-0000-0000-0000000000a1', '한우 채끝 1++', '소', '채끝', '1++', '국내산', '한우', 0, 'kg');

grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;

-- ---------------------------------------------------------------- 도우미 (A 사장 세션)
set role authenticated;
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000001';

insert into public.receiving_policies (wholesaler_id, unlisted_item_policy, over_item_policy)
values ('e4e4e4e4-0000-0000-0000-0000000000a1', 'HOLD', 'HOLD');

create or replace function pg_temp.scan(p_trace text, p_weight numeric, p_product uuid, p_supplier uuid)
returns jsonb language plpgsql as $$
begin
    perform public.upsert_master_livestock(p_trace, 'individual', 'mtrace_livestock', '{}'::jsonb, '한우', '소', '등심', '1++', current_date - 3, '○○도축장');
    return public.record_inbound_scan(
        p_trace_no => p_trace, p_weight => p_weight, p_scan_type => 'BARCODE_SCAN',
        p_product_id => p_product, p_supplier_id => p_supplier);
end $$;

-- ---------------------------------------------------------------- 시나리오 스캔들
-- T1: 발주서 없음(20kg) → UNLISTED_HELD
select pg_temp.scan('009900000001', 20, 'e4e4e4e4-0000-0000-0000-0000000000c1', 'e4e4e4e4-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('T1: UNLISTED_HELD로 재고에 들어감', (:'r'::jsonb) #>> '{po,result}' = 'UNLISTED_HELD');

-- T2: 채끝(P2) 발주서 10kg, 15kg 옴(초과 5kg) → OVER_HELD
insert into public.purchase_orders (id, wholesaler_id, supplier_id, supplier_name, ordered_on, status) values
    ('e4e4e4e4-0000-0000-0000-000000000b01', 'e4e4e4e4-0000-0000-0000-0000000000a1', 'e4e4e4e4-0000-0000-0000-0000000005a1', '공급처가', current_date - 1, 'OPEN');
insert into public.purchase_order_lines (id, purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, product_id) values
    ('e4e4e4e4-0000-0000-0000-00000000f101', 'e4e4e4e4-0000-0000-0000-000000000b01', 'e4e4e4e4-0000-0000-0000-0000000000a1', 1, '소', '채끝', '1++', '국내산', '한우', 10, 'e4e4e4e4-0000-0000-0000-0000000000c2');
select pg_temp.scan('009900000002', 15, 'e4e4e4e4-0000-0000-0000-0000000000c2', 'e4e4e4e4-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('T2: OVER_HELD, 초과 5kg', (:'r'::jsonb) #>> '{po,result}' = 'OVER_HELD' and ((:'r'::jsonb) #>> '{po,excess}')::numeric = 5);

-- T3: 거래처 없이 찍은 스캔(8kg, 등심) — 판정 자체가 없다(po_state NULL)
select pg_temp.scan('009900000003', 8, 'e4e4e4e4-0000-0000-0000-0000000000c1', null) as r \gset
select pg_temp.expect('T3: 거래처 없어 판정 없음', (:'r'::jsonb) -> 'po' is null);

-- T4: 권한 테스트용 여분 UNLISTED_HELD 스캔(6kg)
select pg_temp.scan('009900000004', 6, 'e4e4e4e4-0000-0000-0000-0000000000c1', 'e4e4e4e4-0000-0000-0000-0000000005a1') as r \gset
select pg_temp.expect('T4: UNLISTED_HELD', (:'r'::jsonb) #>> '{po,result}' = 'UNLISTED_HELD');

-- ============================================================== 1) 보류함 진입점: create_purchase_order_from_unlisted_scan
select id as t1_scan_id from public.inbound_scans where trace_no = '009900000001' \gset
select id as t2_scan_id from public.inbound_scans where trace_no = '009900000002' \gset
select id as t3_scan_id from public.inbound_scans where trace_no = '009900000003' \gset
select id as t4_scan_id from public.inbound_scans where trace_no = '009900000004' \gset

select public.create_purchase_order_from_unlisted_scan(:'t1_scan_id') as r1 \gset
select pg_temp.expect('T1 등록: 발주서 20kg 만들어져 바로 발주종결, 스캔 ASSIGNED',
    ((:'r1'::jsonb) ->> 'amount')::numeric = 20
    and (select status = 'CLOSED' and auto_closed_at is not null and quantity = 20
         from public.purchase_orders po join public.purchase_order_lines l on l.purchase_order_id = po.id
         where po.id = ((:'r1'::jsonb) ->> 'order_id')::uuid)
    and (select po_state = 'ASSIGNED' from public.inbound_scans where id = :'t1_scan_id'));

select pg_temp.expect('T1 등록: 전표도 같이 만들어짐(마감 상태, 그 거래처)',
    (select d.status = 'CLOSED' and d.supplier_id = 'e4e4e4e4-0000-0000-0000-0000000005a1' and d.entry_method = 'MANUAL'
     from public.inbound_documents d where d.id = ((:'r1'::jsonb) ->> 'document_id')::uuid)
    and (select l.product_id = 'e4e4e4e4-0000-0000-0000-0000000000c1' and l.labeled_weight = 20
         from public.inbound_document_lines l where l.document_id = ((:'r1'::jsonb) ->> 'document_id')::uuid)
    and (select linked_how = 'AUTO' from public.inbound_document_line_scans where scan_id = :'t1_scan_id'));

select pg_temp.expect_error(format('select public.create_purchase_order_from_unlisted_scan(%L)', :'t1_scan_id'), 'SCAN_NOT_HOLD', '같은 스캔 다시 등록 → SCAN_NOT_HOLD(이미 ASSIGNED)');

select public.create_purchase_order_from_unlisted_scan(:'t2_scan_id') as r2 \gset
select pg_temp.expect('T2 등록: 초과분 5kg만 새 발주서로', ((:'r2'::jsonb) ->> 'amount')::numeric = 5);

select pg_temp.expect_error(format('select public.create_purchase_order_from_unlisted_scan(%L)', :'t3_scan_id'), 'SCAN_HAS_NO_SUPPLIER', '거래처 없는 스캔 → SCAN_HAS_NO_SUPPLIER');

-- 권한: 직원(staff)은 못 만든다
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000003';
select pg_temp.expect_error(format('select public.create_purchase_order_from_unlisted_scan(%L)', :'t4_scan_id'), 'FORBIDDEN', '직원은 FORBIDDEN');

-- 매니저는 만들 수 있다
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000002';
select public.create_purchase_order_from_unlisted_scan(:'t4_scan_id') as r4 \gset
select pg_temp.expect('매니저는 등록 가능(T4)', ((:'r4'::jsonb) ->> 'amount')::numeric = 6);

set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000001';

-- 격리: B 세션에서 A의 스캔은 안 보인다
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000004';
select pg_temp.expect_error(format('select public.create_purchase_order_from_unlisted_scan(%L)', :'t3_scan_id'), 'SCAN_NOT_FOUND', '격리: B 세션에서 A 스캔 → SCAN_NOT_FOUND');
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000001';

-- ============================================================== 2) 전표 대조 진입점: create_purchase_order_from_document_scan
insert into public.inbound_documents (id, wholesaler_id, supplier_id, supplier_name, status, entry_method) values
    ('e4e4e4e4-0000-0000-0000-000000000d01', 'e4e4e4e4-0000-0000-0000-0000000000a1', 'e4e4e4e4-0000-0000-0000-0000000005a1', '공급처가', 'PENDING', 'MANUAL');
insert into public.inbound_document_lines (id, document_id, line_no, item_name, product_id) values
    ('e4e4e4e4-0000-0000-0000-000000000e01', 'e4e4e4e4-0000-0000-0000-000000000d01', 1, '한우 등심', 'e4e4e4e4-0000-0000-0000-0000000000c1');
select public.link_scan_to_document_line(:'t3_scan_id', 'e4e4e4e4-0000-0000-0000-000000000e01', 'MANUAL');

select public.create_purchase_order_from_document_scan(:'t3_scan_id') as r3 \gset
select pg_temp.expect('T3(거래처 없던 스캔) → 전표의 거래처로 발주서 8kg 등록, 전표는 새로 안 만듦',
    ((:'r3'::jsonb) ->> 'amount')::numeric = 8
    and (:'r3'::jsonb) -> 'document_id' is null
    and (select po_state = 'ASSIGNED' from public.inbound_scans where id = :'t3_scan_id'));

select pg_temp.expect_error(format('select public.create_purchase_order_from_document_scan(%L)', :'t3_scan_id'), 'NOTHING_TO_ASSIGN', '같은 스캔 다시 → NOTHING_TO_ASSIGN');

-- 격리: B 세션이 A 전표에 이어진 스캔으로 호출 → 테넌트 스코프에서 곧바로 막힘(SCAN_NOT_ON_DOCUMENT)
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000004';
select pg_temp.expect_error(format('select public.create_purchase_order_from_document_scan(%L)', :'t3_scan_id'), 'SCAN_NOT_ON_DOCUMENT', '격리: B가 A 전표에 이어진 스캔으로 호출 → SCAN_NOT_ON_DOCUMENT');
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000001';

-- 전표에 거래처가 없으면 거부
select pg_temp.scan('009900000005', 6, 'e4e4e4e4-0000-0000-0000-0000000000c1', null) as r \gset
select id as t5_scan_id from public.inbound_scans where trace_no = '009900000005' \gset
insert into public.inbound_documents (id, wholesaler_id, supplier_id, supplier_name, status, entry_method) values
    ('e4e4e4e4-0000-0000-0000-000000000d02', 'e4e4e4e4-0000-0000-0000-0000000000a1', null, '아직 미정', 'PENDING', 'MANUAL');
insert into public.inbound_document_lines (id, document_id, line_no, item_name, product_id) values
    ('e4e4e4e4-0000-0000-0000-000000000e02', 'e4e4e4e4-0000-0000-0000-000000000d02', 1, '한우 등심', 'e4e4e4e4-0000-0000-0000-0000000000c1');
select public.link_scan_to_document_line(:'t5_scan_id', 'e4e4e4e4-0000-0000-0000-000000000e02', 'MANUAL');
select pg_temp.expect_error(format('select public.create_purchase_order_from_document_scan(%L)', :'t5_scan_id'), 'DOCUMENT_SUPPLIER_REQUIRED', '전표에 거래처 없음 → DOCUMENT_SUPPLIER_REQUIRED');

-- 어느 전표에도 안 이어진 스캔은 거부
select pg_temp.scan('009900000006', 4, 'e4e4e4e4-0000-0000-0000-0000000000c1', null) as r \gset
select id as t6_scan_id from public.inbound_scans where trace_no = '009900000006' \gset
select pg_temp.expect_error(format('select public.create_purchase_order_from_document_scan(%L)', :'t6_scan_id'), 'SCAN_NOT_ON_DOCUMENT', '전표에 안 이어진 스캔 → SCAN_NOT_ON_DOCUMENT');

-- ============================================================== 3) 전표 거래처 설정: set_document_supplier
select public.set_document_supplier('e4e4e4e4-0000-0000-0000-000000000d02', 'e4e4e4e4-0000-0000-0000-0000000005a1');
select pg_temp.expect('전표에 거래처 설정됨', (select supplier_id = 'e4e4e4e4-0000-0000-0000-0000000005a1' from public.inbound_documents where id = 'e4e4e4e4-0000-0000-0000-000000000d02'));

select pg_temp.expect_error(format('select public.set_document_supplier(%L, gen_random_uuid())', 'e4e4e4e4-0000-0000-0000-000000000d02'), 'SUPPLIER_NOT_FOUND', '없는 거래처 → SUPPLIER_NOT_FOUND');

set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000003';
select pg_temp.expect_error(format('select public.set_document_supplier(%L, %L)', 'e4e4e4e4-0000-0000-0000-000000000d02', 'e4e4e4e4-0000-0000-0000-0000000005a1'), 'FORBIDDEN', '직원은 전표 거래처 설정 FORBIDDEN');
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000001';

-- 격리: B 세션은 A의 전표를 못 고친다(자기 거래처는 유효하니 DOCUMENT_NOT_FOUND로 걸려야 함)
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000004';
select pg_temp.expect_error(format('select public.set_document_supplier(%L, %L)', 'e4e4e4e4-0000-0000-0000-000000000d02', 'e4e4e4e4-0000-0000-0000-0000000005b1'), 'DOCUMENT_NOT_FOUND', '격리: B가 A 전표 거래처 설정 → DOCUMENT_NOT_FOUND');
set request.jwt.claim.sub = 'e4e4e4e4-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------- 정리
reset role;
delete from public.inbound_document_line_scans where line_id in (select id from public.inbound_document_lines where document_id in ('e4e4e4e4-0000-0000-0000-000000000d01','e4e4e4e4-0000-0000-0000-000000000d02')) or scan_id in (select id from public.inbound_scans where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2'));
delete from public.inbound_document_lines where document_id in (select id from public.inbound_documents where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2'));
delete from public.inbound_documents where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.purchase_order_line_scans where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.stock_ledger where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.inbound_scans where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.purchase_orders where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.trace_product_map where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.products where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.suppliers where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.receiving_policies where wholesaler_id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.organization_staff where organization_id = 'e4e4e4e4-0000-0000-0000-0000000010a1';
delete from public.organizations where id = 'e4e4e4e4-0000-0000-0000-0000000010a1';
delete from public.wholesalers where id in ('e4e4e4e4-0000-0000-0000-0000000000a1','e4e4e4e4-0000-0000-0000-0000000000a2');
delete from public.master_livestock where trace_no like '0099000000%';
delete from public.profiles where id in ('e4e4e4e4-0000-0000-0000-000000000001','e4e4e4e4-0000-0000-0000-000000000002','e4e4e4e4-0000-0000-0000-000000000003','e4e4e4e4-0000-0000-0000-000000000004');
delete from auth.users where id in ('e4e4e4e4-0000-0000-0000-000000000001','e4e4e4e4-0000-0000-0000-000000000002','e4e4e4e4-0000-0000-0000-000000000003','e4e4e4e4-0000-0000-0000-000000000004');
