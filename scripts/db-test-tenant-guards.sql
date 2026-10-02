-- 공급사 간 섞임 방어 검사(마이그 200). 로컬 Docker DB 전용, 전부 롤백. 실행:
--   (echo "begin;"; cat scripts/db-test-tenant-guards.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- 1부는 카탈로그를 읽어 "새 표·새 참조 컬럼이 생기면 자동으로 걸리는" 구조 검사, 2부는 실제 교차 시도(정상 대조군 포함), 3부는 점검 함수 자체 검증.
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
    raise notice 'PASS: %', p_name;
end $$;

-- 주어진 SQL이 TENANT_REF_MISMATCH로 거부되는지.
create or replace function pg_temp.blocked(p_name text, p_sql text) returns void language plpgsql as $$
declare v_msg text;
begin
    begin
        execute p_sql;
        v_msg := null;
    exception when others then
        v_msg := sqlerrm;
    end;
    if v_msg is null then raise exception 'FAIL(통과해 버림): %', p_name; end if;
    if v_msg not like 'TENANT_REF_MISMATCH%' then raise exception 'FAIL(다른 이유로 거부됨: %): %', v_msg, p_name; end if;
    raise notice 'PASS: % → 거부', p_name;
end $$;

-- ───────────── 1부: 구조 검사(카탈로그 기반) ─────────────

-- 1-1) wholesaler_id가 있는 모든 표는 RLS가 켜져 있어야 한다.
select pg_temp.expect('공급사 소유 표 전부 RLS 켜짐',
    not exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'wholesaler_id' and not a.attisdropped
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity));

-- 1-2) 공급사 소유 표가 공급사 소유 표를 단일 컬럼 FK로 가리키면 소속 일치 가드가 있어야 한다.
--      가드 = enforce_tenant_refs 트리거에 '컬럼:부모표'가 있거나, 같은 표에 *tenant*·*integrity* 이름의 기존 가드 트리거가 있는 경우.
do $$
declare r record; v_missing text := '';
begin
    for r in
        with tenant as (
            select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              join pg_attribute a on a.attrelid = c.oid and a.attname = 'wholesaler_id' and not a.attisdropped
             where n.nspname = 'public' and c.relkind = 'r')
        select t.oid as toid, t.relname child, a.attname fkcol, p.relname parent
          from tenant t
          join pg_constraint k on k.conrelid = t.oid and k.contype = 'f' and array_length(k.conkey, 1) = 1
          join pg_attribute a on a.attrelid = t.oid and a.attnum = k.conkey[1]
          join tenant p on p.oid = k.confrelid
    loop
        if not exists (
            select 1 from pg_trigger g
             where g.tgrelid = r.toid and not g.tgisinternal
               and ( pg_get_triggerdef(g.oid) like '%enforce_tenant_refs%' || r.fkcol || ':' || r.parent || '%'
                  or (g.tgname ilike '%tenant%' and g.tgname not like '%tenant_refs')
                  or g.tgname ilike '%integrity%')
        ) then
            v_missing := v_missing || r.child || '.' || r.fkcol || '→' || r.parent || ' ';
        end if;
    end loop;
    perform pg_temp.expect('모든 공급사 간 참조 컬럼에 소속 일치 가드가 있다 (누락: ' || coalesce(nullif(v_missing, ''), '없음') || ')', v_missing = '');
end $$;

-- 1-3) SECURITY DEFINER 트리거 함수·점검 함수는 일반 사용자가 직접 못 부른다.
select pg_temp.expect('enforce_tenant_refs·tenant_consistency_violations는 anon·authenticated 호출 불가',
    not has_function_privilege('anon', 'public.tenant_consistency_violations()', 'execute')
    and not has_function_privilege('authenticated', 'public.tenant_consistency_violations()', 'execute')
    and not has_function_privilege('authenticated', 'public.enforce_tenant_refs()', 'execute'));

-- ───────────── 2부: 실제 교차 시도 ─────────────

insert into auth.users (id, email) values
    ('d1000000-0000-0000-0000-000000000001', 'ga@t.com'), ('d1000000-0000-0000-0000-000000000002', 'gb@t.com'), ('d1000000-0000-0000-0000-000000000003', 'gr@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values
    ('d1000000-0000-0000-0000-000000000001', 'wholesaler', 'A', '010'),
    ('d1000000-0000-0000-0000-000000000002', 'wholesaler', 'B', '011'),
    ('d1000000-0000-0000-0000-000000000003', 'retailer', 'R', '012') on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name) values
    ('d1000000-0000-0000-0000-0000000000a1', 'd1000000-0000-0000-0000-000000000001', 'A축', '1110000085', 'A'),
    ('d1000000-0000-0000-0000-0000000000b1', 'd1000000-0000-0000-0000-000000000002', 'B축', '1110000093', 'B');
insert into public.retailers (id, profile_id, restaurant_name, representative_name, delivery_address)
    values ('d3000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000003', '공통식당', 'R', '주소');

insert into public.products (id, wholesaler_id, name, category, subcategory, origin, grade, breed, storage_state, base_price, unit, stock_quantity, is_active) values
    ('d2000000-0000-0000-0000-00000000000a', 'd1000000-0000-0000-0000-0000000000a1', 'A상품', '소', '등심', '국내산', '1+', '한우', '냉장', 100, 'kg', 0, true),
    ('d2000000-0000-0000-0000-00000000000b', 'd1000000-0000-0000-0000-0000000000b1', 'B상품', '소', '등심', '국내산', '1+', '한우', '냉장', 100, 'kg', 0, true);
insert into public.suppliers (id, wholesaler_id, name, name_key) values
    ('d4000000-0000-0000-0000-00000000000a', 'd1000000-0000-0000-0000-0000000000a1', 'A거래처', 'a'),
    ('d4000000-0000-0000-0000-00000000000b', 'd1000000-0000-0000-0000-0000000000b1', 'B거래처', 'b');
insert into public.inbound_scans (id, wholesaler_id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight) values
    ('d5000000-0000-0000-0000-00000000000a', 'd1000000-0000-0000-0000-0000000000a1', 'GA0000000001', 'd2000000-0000-0000-0000-00000000000a', 10, 'kg', 'MANUAL', 'NORMAL', 10),
    ('d5000000-0000-0000-0000-00000000000b', 'd1000000-0000-0000-0000-0000000000b1', 'GB0000000001', 'd2000000-0000-0000-0000-00000000000b', 10, 'kg', 'MANUAL', 'NORMAL', 10);

-- 대조군: 같은 공급사끼리는 통과해야 한다(과차단 방지).
insert into public.custom_prices (wholesaler_id, retailer_id, product_id, custom_price) values ('d1000000-0000-0000-0000-0000000000a1', 'd3000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-00000000000a', 90);
insert into public.product_purchase_prices (wholesaler_id, product_id, unit_price) values ('d1000000-0000-0000-0000-0000000000a1', 'd2000000-0000-0000-0000-00000000000a', 50);
insert into public.inbound_scans (wholesaler_id, trace_no, product_id, supplier_id, parent_scan_id, weight, unit, scan_type, status, remaining_weight)
    values ('d1000000-0000-0000-0000-0000000000a1', 'GA0000000002', 'd2000000-0000-0000-0000-00000000000a', 'd4000000-0000-0000-0000-00000000000a', 'd5000000-0000-0000-0000-00000000000a', 5, 'kg', 'MANUAL', 'NORMAL', 5);
insert into public.stock_ledger (wholesaler_id, product_id, inbound_scan_id, qty_delta, event_type, source_type, reason)
    values ('d1000000-0000-0000-0000-0000000000a1', 'd2000000-0000-0000-0000-00000000000a', 'd5000000-0000-0000-0000-00000000000a', 1, 'ADJUSTMENT', 'manual', '대조군');
select pg_temp.expect('대조군: 같은 공급사 참조는 전부 통과한다', true);

-- 공격: A 소유 행이 B의 상품·박스·거래처를 가리키게 한다.
select pg_temp.blocked('맞춤단가: A가 B 상품에 가격 등록 (이번에 찾은 구멍)',
    $q$insert into public.custom_prices (wholesaler_id, retailer_id, product_id, custom_price) values ('d1000000-0000-0000-0000-0000000000a1', 'd3000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-00000000000b', 1)$q$);
select pg_temp.blocked('맞춤단가: A 행의 상품을 B 상품으로 바꿔치기(UPDATE)',
    $q$update public.custom_prices set product_id = 'd2000000-0000-0000-0000-00000000000b' where wholesaler_id = 'd1000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.blocked('매입단가: A가 B 상품에 매입가 등록',
    $q$insert into public.product_purchase_prices (wholesaler_id, product_id, unit_price) values ('d1000000-0000-0000-0000-0000000000a1', 'd2000000-0000-0000-0000-00000000000b', 1)$q$);
select pg_temp.blocked('박스: A 박스가 B 상품을 가리킴',
    $q$insert into public.inbound_scans (wholesaler_id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight) values ('d1000000-0000-0000-0000-0000000000a1', 'GX0000000001', 'd2000000-0000-0000-0000-00000000000b', 1, 'kg', 'MANUAL', 'NORMAL', 1)$q$);
select pg_temp.blocked('박스: A 박스가 B 거래처를 가리킴',
    $q$insert into public.inbound_scans (wholesaler_id, trace_no, supplier_id, weight, unit, scan_type, status, remaining_weight) values ('d1000000-0000-0000-0000-0000000000a1', 'GX0000000002', 'd4000000-0000-0000-0000-00000000000b', 1, 'kg', 'MANUAL', 'NORMAL', 1)$q$);
select pg_temp.blocked('박스: A 박스의 부모가 B 박스(쪼개기 위조)',
    $q$insert into public.inbound_scans (wholesaler_id, trace_no, parent_scan_id, weight, unit, scan_type, status, remaining_weight) values ('d1000000-0000-0000-0000-0000000000a1', 'GX0000000003', 'd5000000-0000-0000-0000-00000000000b', 1, 'kg', 'MANUAL', 'NORMAL', 1)$q$);
select pg_temp.blocked('박스: A 박스의 상품을 B 상품으로 바꿔치기(UPDATE)',
    $q$update public.inbound_scans set product_id = 'd2000000-0000-0000-0000-00000000000b' where id = 'd5000000-0000-0000-0000-00000000000a'$q$);
select pg_temp.blocked('재고 원장: A 원장이 B 상품을 가리킴',
    $q$insert into public.stock_ledger (wholesaler_id, product_id, qty_delta, event_type, source_type, reason) values ('d1000000-0000-0000-0000-0000000000a1', 'd2000000-0000-0000-0000-00000000000b', 5, 'ADJUSTMENT', 'manual', 'x')$q$);
select pg_temp.blocked('재고 원장: A 원장이 B 박스를 가리킴',
    $q$insert into public.stock_ledger (wholesaler_id, product_id, inbound_scan_id, qty_delta, event_type, source_type, reason) values ('d1000000-0000-0000-0000-0000000000a1', 'd2000000-0000-0000-0000-00000000000a', 'd5000000-0000-0000-0000-00000000000b', 5, 'ADJUSTMENT', 'manual', 'x')$q$);

-- ───────────── 3부: 점검 함수가 실제로 섞임을 잡는지 ─────────────

select pg_temp.expect('깨끗한 상태에서 점검 함수는 위반 0건', (select coalesce(sum(violations), 0) from public.tenant_consistency_violations()) = 0);

-- 트리거를 일부러 우회해(복제 모드) 섞인 행을 만든 뒤, 점검 함수가 잡아내는지 본다.
set session_replication_role = replica;
insert into public.inbound_scans (wholesaler_id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight)
    values ('d1000000-0000-0000-0000-0000000000a1', 'GM0000000001', 'd2000000-0000-0000-0000-00000000000b', 1, 'kg', 'MANUAL', 'NORMAL', 1);
set session_replication_role = origin;
select pg_temp.expect('우회로 섞인 행을 점검 함수가 inbound_scans.product_id에서 1건 잡는다',
    (select violations from public.tenant_consistency_violations() where ref = 'inbound_scans.product_id') = 1);
