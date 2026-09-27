-- 소 품종(한우/육우/젖소) 정체성 — 마이그레이션 140 검증. 로컬 Docker DB 전용, 끝에서 자기 데이터를 지운다.
-- 실행: docker exec -i supabase_db_wholesale psql -U postgres -v ON_ERROR_STOP=1 < scripts/db-test-cattle-breed.sql
-- 각 검증은 "PASS n: ..." / 실패 시 예외로 멈춘다.
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then
        raise exception 'FAIL: %', p_name;
    end if;
    raise notice 'PASS: %', p_name;
end $$;

insert into auth.users (id, email) values ('c1c1c1c1-0000-0000-0000-000000000001', 'breed@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values ('c1c1c1c1-0000-0000-0000-000000000001', 'wholesaler', 'A', '010')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name)
    values ('c1c1c1c1-0000-0000-0000-0000000000a1', 'c1c1c1c1-0000-0000-0000-000000000001', '품종축산', '1110000077', 'A');

grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date) to authenticated;

-- 1) trace_breed: 축종 원문 → 품종
select pg_temp.expect('trace_breed 한우/육우/젖소/그 외',
    public.trace_breed('한우') = '한우' and public.trace_breed('육우') = '육우' and public.trace_breed('젖소') = '젖소'
    and public.trace_breed('소') is null and public.trace_breed(null) is null and public.trace_breed('홀스타인') is null);

-- 2) 제약: 소만 품종을 가질 수 있고, 값은 셋 중 하나
do $$
declare v_ok boolean;
begin
    insert into public.products (wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit)
    values ('c1c1c1c1-0000-0000-0000-0000000000a1', '한우 등심 1++', '소', '등심', '1++', '국내산', '한우', 0, 'kg');
    insert into public.products (wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit)
    values ('c1c1c1c1-0000-0000-0000-0000000000a1', '육우 등심 1++', '소', '등심', '1++', '국내산', '육우', 0, 'kg');
    perform pg_temp.expect('한우·육우는 같은 부위·등급·원산지라도 별개 상품으로 등록됨', (select count(*) from public.products where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1') = 2);

    v_ok := false;
    begin
        insert into public.products (wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit)
        values ('c1c1c1c1-0000-0000-0000-0000000000a1', '한우 등심 1++ 중복', '소', '등심', '1++', '국내산', '한우', 0, 'kg');
    exception when unique_violation then v_ok := true; end;
    perform pg_temp.expect('같은 품종의 같은 상품은 중복 거부', v_ok);

    v_ok := false;
    begin
        insert into public.products (wholesaler_id, name, category, subcategory, origin, breed, base_price, unit)
        values ('c1c1c1c1-0000-0000-0000-0000000000a1', '돼지 삼겹살', '돼지', '삼겹살', '국내산', '한우', 0, 'kg');
    exception when check_violation then v_ok := true; end;
    perform pg_temp.expect('소가 아닌 상품에 품종 넣기 거부', v_ok);

    v_ok := false;
    begin
        insert into public.products (wholesaler_id, name, category, subcategory, grade, origin, breed, base_price, unit)
        values ('c1c1c1c1-0000-0000-0000-0000000000a1', '이상한 소', '소', '안심', '1', '국내산', '흑우', 0, 'kg');
    exception when check_violation then v_ok := true; end;
    perform pg_temp.expect('목록 밖 품종 거부', v_ok);

    -- 품종이 빈 옛 소 상품(보관됨)도 그대로 존재할 수 있고, 같은 빈 품종끼리만 겹친다
    insert into public.products (wholesaler_id, name, category, subcategory, grade, origin, base_price, unit, archived_at)
    values ('c1c1c1c1-0000-0000-0000-0000000000a1', '등심 1+', '소', '등심', '1+', '국내산', 0, 'kg', now());
    v_ok := false;
    begin
        insert into public.products (wholesaler_id, name, category, subcategory, grade, origin, base_price, unit)
        values ('c1c1c1c1-0000-0000-0000-0000000000a1', '등심 1+ 또', '소', '등심', '1+', '국내산', 0, 'kg');
    exception when unique_violation then v_ok := true; end;
    perform pg_temp.expect('품종 빈 옛 소 상품끼리는 여전히 중복 거부', v_ok);
end $$;

-- 3) 발주서 줄: 소는 품종 필수, 소가 아니면 품종 금지
do $$
declare v_po uuid; v_ok boolean; v_sup uuid;
begin
    insert into public.suppliers (wholesaler_id, name) values ('c1c1c1c1-0000-0000-0000-0000000000a1', '테스트 공급처') returning id into v_sup;
    insert into public.purchase_orders (wholesaler_id, supplier_id, supplier_name, ordered_on, status)
    values ('c1c1c1c1-0000-0000-0000-0000000000a1', v_sup, '테스트 공급처', current_date, 'OPEN') returning id into v_po;

    insert into public.purchase_order_lines (purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity)
    values (v_po, 'c1c1c1c1-0000-0000-0000-0000000000a1', 1, '소', '등심', '1++', '국내산', '한우', 50);
    perform pg_temp.expect('소 발주 줄(품종 있음) 저장됨', true);

    v_ok := false;
    begin
        insert into public.purchase_order_lines (purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, quantity)
        values (v_po, 'c1c1c1c1-0000-0000-0000-0000000000a1', 2, '소', '안심', '1+', '국내산', 10);
    exception when check_violation then v_ok := true; end;
    perform pg_temp.expect('소 발주 줄에 품종이 없으면 거부', v_ok);

    v_ok := false;
    begin
        insert into public.purchase_order_lines (purchase_order_id, wholesaler_id, line_no, category, subcategory, origin, breed, quantity)
        values (v_po, 'c1c1c1c1-0000-0000-0000-0000000000a1', 3, '돼지', '삼겹살', '국내산', '한우', 10);
    exception when check_violation then v_ok := true; end;
    perform pg_temp.expect('돼지 발주 줄에 품종이 있으면 거부', v_ok);

    insert into public.purchase_order_lines (purchase_order_id, wholesaler_id, line_no, category, subcategory, origin, quantity)
    values (v_po, 'c1c1c1c1-0000-0000-0000-0000000000a1', 4, '돼지', '삼겹살', '국내산', 10);
    perform pg_temp.expect('돼지 발주 줄(품종 없음) 저장됨', true);
end $$;

-- 4) 스캔: 품종별 자동 생성·학습 매핑
delete from public.products where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';

set role authenticated;
set request.jwt.claim.sub = 'c1c1c1c1-0000-0000-0000-000000000001';

select public.upsert_master_livestock('002900000001','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('002900000002','individual','mtrace_livestock','{}'::jsonb,'육우','소','등심','1++',current_date-3,'○○도축장');
select public.upsert_master_livestock('002900000003','individual','mtrace_livestock','{}'::jsonb,'한우','소','등심','1++',current_date-2,'○○도축장');
select public.upsert_master_livestock('002900000004','individual','mtrace_livestock','{}'::jsonb,null,'소','등심','1++',current_date-2,'○○도축장');

select public.record_inbound_scan('002900000001', 8.0, 'BARCODE_SCAN');
select public.autocreate_product_for_scan((select id from public.inbound_scans where trace_no = '002900000001'));

select public.record_inbound_scan('002900000002', 7.0, 'BARCODE_SCAN');

reset role;
select pg_temp.expect('육우 스캔은 한우 상품으로 학습 매핑되지 않고 대기(PENDING_MAPPING)로 남음',
    (select status from public.inbound_scans where trace_no = '002900000002') = 'PENDING_MAPPING');

set role authenticated;
set request.jwt.claim.sub = 'c1c1c1c1-0000-0000-0000-000000000001';
select public.autocreate_product_for_scan((select id from public.inbound_scans where trace_no = '002900000002'));
select public.record_inbound_scan('002900000003', 6.0, 'BARCODE_SCAN');
select public.record_inbound_scan('002900000004', 5.0, 'BARCODE_SCAN');
reset role;

select pg_temp.expect('한우 상품 "한우 등심 1++"과 육우 상품 "육우 등심 1++"이 따로 생김',
    (select count(*) from public.products where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1' and category = '소') = 2
    and exists (select 1 from public.products where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1' and name = '한우 등심 1++' and breed = '한우')
    and exists (select 1 from public.products where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1' and name = '육우 등심 1++' and breed = '육우'));
select pg_temp.expect('같은 한우 등심 1++ 재스캔은 학습 매핑으로 바로 NORMAL',
    (select status from public.inbound_scans where trace_no = '002900000003') = 'NORMAL');
select pg_temp.expect('품종을 모르는 소(이력조회 축종 없음)는 자동으로 붙지 않고 대기로 남음',
    (select status from public.inbound_scans where trace_no = '002900000004') = 'PENDING_MAPPING');

set role authenticated;
set request.jwt.claim.sub = 'c1c1c1c1-0000-0000-0000-000000000001';
select pg_temp.expect('품종을 모르는 소의 자동 생성은 BREED_UNKNOWN으로 거절',
    (public.autocreate_product_for_scan((select id from public.inbound_scans where trace_no = '002900000004'))) ->> 'reason' = 'BREED_UNKNOWN');
select pg_temp.expect('list_product_options가 품종을 돌려줌',
    exists (select 1 from jsonb_array_elements(public.list_product_options('c1c1c1c1-0000-0000-0000-0000000000a1')) e where e ->> 'breed' = '육우'));
reset role;

-- 정리
set session_replication_role = replica;
delete from public.stock_ledger where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.livestock_exception_log where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.inbound_scans where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.trace_product_map where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.purchase_order_lines where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.purchase_orders where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.suppliers where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.products where wholesaler_id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.wholesalers where id = 'c1c1c1c1-0000-0000-0000-0000000000a1';
delete from public.profiles where id = 'c1c1c1c1-0000-0000-0000-000000000001';
delete from auth.users where id = 'c1c1c1c1-0000-0000-0000-000000000001';
delete from public.master_livestock where trace_no in ('002900000001','002900000002','002900000003','002900000004');
set session_replication_role = origin;
