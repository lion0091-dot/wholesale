-- 주문·고객 섞임 격리 검사(공급사 A·B, 고객 R1(둘 다와 거래)·R2(A와만 거래)). 로컬 Docker DB 전용, 전부 롤백. 실행:
--   (echo "begin;"; cat scripts/db-test-order-customer-isolation.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- 시드 후, 각 계정으로 로그인한 상태에서 "보이는 행"과 "건드릴 수 있는 행"이 정확히 자기 것뿐인지 본다.
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAIL: %', p_name; end if;
    raise notice 'PASS: %', p_name;
end $$;

-- 해당 계정(profile id)으로 로그인한 상태에서 SQL 하나를 실행하고 첫 칸(개수)을 돌려준다. 쓰기는 영향 행 수를 돌려준다.
create or replace function pg_temp.count_as(p_sub uuid, p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    if p_sql ~* '^\s*(insert|update|delete)' then
        execute p_sql;
        get diagnostics v = row_count;
    else
        execute p_sql into v;
    end if;
    execute 'reset role';
    return v;
exception when others then
    execute 'reset role';
    return -1;  -- 거부(RLS·트리거 오류)
end $$;

insert into auth.users (id, email) values
    ('e1000000-0000-0000-0000-00000000000a', 'oa@t.com'), ('e1000000-0000-0000-0000-00000000000b', 'ob@t.com'),
    ('e1000000-0000-0000-0000-0000000000f1', 'r1@t.com'), ('e1000000-0000-0000-0000-0000000000f2', 'r2@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values
    ('e1000000-0000-0000-0000-00000000000a', 'wholesaler', 'OA', '010'), ('e1000000-0000-0000-0000-00000000000b', 'wholesaler', 'OB', '011'),
    ('e1000000-0000-0000-0000-0000000000f1', 'retailer', 'R1', '012'), ('e1000000-0000-0000-0000-0000000000f2', 'retailer', 'R2', '013')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name, status) values
    ('e2000000-0000-0000-0000-0000000000a1', 'e1000000-0000-0000-0000-00000000000a', 'A축', '1110000085', 'A', 'active'),
    ('e2000000-0000-0000-0000-0000000000b1', 'e1000000-0000-0000-0000-00000000000b', 'B축', '1110000093', 'B', 'active');
insert into public.retailers (id, profile_id, restaurant_name, representative_name, delivery_address) values
    ('e3000000-0000-0000-0000-0000000000f1', 'e1000000-0000-0000-0000-0000000000f1', '식당1', 'R1', '주소1'),
    ('e3000000-0000-0000-0000-0000000000f2', 'e1000000-0000-0000-0000-0000000000f2', '식당2', 'R2', '주소2');
insert into public.wholesaler_retailers (wholesaler_id, retailer_id, status) values
    ('e2000000-0000-0000-0000-0000000000a1', 'e3000000-0000-0000-0000-0000000000f1', 'active'),
    ('e2000000-0000-0000-0000-0000000000a1', 'e3000000-0000-0000-0000-0000000000f2', 'active'),
    ('e2000000-0000-0000-0000-0000000000b1', 'e3000000-0000-0000-0000-0000000000f1', 'active');
insert into public.products (id, wholesaler_id, name, category, subcategory, origin, grade, breed, storage_state, base_price, unit, stock_quantity, is_active) values
    ('e4000000-0000-0000-0000-00000000000a', 'e2000000-0000-0000-0000-0000000000a1', 'A상품', '소', '등심', '국내산', '1+', '한우', '냉장', 100, 'kg', 100, true),
    ('e4000000-0000-0000-0000-00000000000b', 'e2000000-0000-0000-0000-0000000000b1', 'B상품', '소', '등심', '국내산', '1+', '한우', '냉장', 100, 'kg', 100, true);

insert into public.orders (id, order_number, wholesaler_id, retailer_id, delivery_address, total_amount) values
    ('e5000000-0000-0000-0000-0000000000a1', 'ISO-A-R1', 'e2000000-0000-0000-0000-0000000000a1', 'e3000000-0000-0000-0000-0000000000f1', '주소1', 1000),
    ('e5000000-0000-0000-0000-0000000000b1', 'ISO-B-R1', 'e2000000-0000-0000-0000-0000000000b1', 'e3000000-0000-0000-0000-0000000000f1', '주소1', 2000),
    ('e5000000-0000-0000-0000-0000000000a2', 'ISO-A-R2', 'e2000000-0000-0000-0000-0000000000a1', 'e3000000-0000-0000-0000-0000000000f2', '주소2', 3000);
insert into public.order_items (order_id, product_id, product_name, quantity, unit_price, subtotal_amount) values
    ('e5000000-0000-0000-0000-0000000000a1', 'e4000000-0000-0000-0000-00000000000a', 'A상품', 10, 100, 1000),
    ('e5000000-0000-0000-0000-0000000000b1', 'e4000000-0000-0000-0000-00000000000b', 'B상품', 20, 100, 2000),
    ('e5000000-0000-0000-0000-0000000000a2', 'e4000000-0000-0000-0000-00000000000a', 'A상품', 30, 100, 3000);
insert into public.custom_prices (wholesaler_id, retailer_id, product_id, custom_price) values
    ('e2000000-0000-0000-0000-0000000000a1', 'e3000000-0000-0000-0000-0000000000f1', 'e4000000-0000-0000-0000-00000000000a', 90),
    ('e2000000-0000-0000-0000-0000000000b1', 'e3000000-0000-0000-0000-0000000000f1', 'e4000000-0000-0000-0000-00000000000b', 80);

insert into public.inbound_import_jobs (id, wholesaler_id, file_name) values
    ('e6000000-0000-0000-0000-0000000000a1', 'e2000000-0000-0000-0000-0000000000a1', 'a.xlsx'),
    ('e6000000-0000-0000-0000-0000000000b1', 'e2000000-0000-0000-0000-0000000000b1', 'b.xlsx');
insert into public.inbound_import_rows (job_id, row_no, trace_no) values
    ('e6000000-0000-0000-0000-0000000000a1', 1, 'IMPA0000001'), ('e6000000-0000-0000-0000-0000000000a1', 2, 'IMPA0000002'),
    ('e6000000-0000-0000-0000-0000000000b1', 1, 'IMPB0000001');

-- ───────────── 공급사 A: 자기 주문 2건(R1·R2)만 ─────────────
select pg_temp.expect('A 사장: 주문은 자기 것 2건만 (B의 R1 주문이 안 보임)',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', 'select count(*) from public.orders') = 2);
select pg_temp.expect('A 사장: 주문 품목도 자기 것 2줄만',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', 'select count(*) from public.order_items') = 2);
select pg_temp.expect('A 사장: 맞춤단가는 자기 것 1건만',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', 'select count(*) from public.custom_prices') = 1);
select pg_temp.expect('A 사장: 거래처 연결은 자기 것 2건만',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', 'select count(*) from public.wholesaler_retailers') = 2);
select pg_temp.expect('A 사장: 상품은 자기 것만',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', $q$select count(*) from public.products where name like '%상품'$q$) = 1);

-- ───────────── 공급사 B: R1 주문 1건만, 거래 안 하는 고객 R2는 안 보임 ─────────────
select pg_temp.expect('B 사장: 주문은 자기 것 1건만',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000b', 'select count(*) from public.orders') = 1);
select pg_temp.expect('B 사장: 거래하지 않는 고객 R2 정보는 못 본다',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000b', $q$select count(*) from public.retailers where id = 'e3000000-0000-0000-0000-0000000000f2'$q$) = 0);
select pg_temp.expect('B 사장: 거래 고객 R1은 본다(과차단 아님)',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000b', $q$select count(*) from public.retailers where id = 'e3000000-0000-0000-0000-0000000000f1'$q$) = 1);

-- ───────────── 고객 R1(두 공급사와 거래): 자기 주문 2건만, R2의 주문은 안 보임 ─────────────
select pg_temp.expect('고객 R1: 주문은 자기 것 2건(A·B)만, R2의 주문이 안 보임',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f1', 'select count(*) from public.orders') = 2);
select pg_temp.expect('고객 R1: 주문 품목도 자기 것 2줄만',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f1', 'select count(*) from public.order_items') = 2);
select pg_temp.expect('고객 R1: 맞춤단가는 자기 것 2건',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f1', 'select count(*) from public.custom_prices') = 2);

-- ───────────── 고객 R2(A와만 거래): 자기 주문만, 남의 맞춤단가·주문 없음 ─────────────
select pg_temp.expect('고객 R2: 주문은 자기 것 1건만',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f2', 'select count(*) from public.orders') = 1);
select pg_temp.expect('고객 R2: 남(R1)의 맞춤단가가 하나도 안 보임',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f2', 'select count(*) from public.custom_prices') = 0);
select pg_temp.expect('고객 R2: 다른 고객(R1) 정보가 안 보임',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f2', $q$select count(*) from public.retailers where id = 'e3000000-0000-0000-0000-0000000000f1'$q$) = 0);

-- ───────────── 쓰기: 남의 주문을 건드릴 수 없다 ─────────────
select pg_temp.expect('A 사장이 B의 주문을 UPDATE 하면 0행',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', $q$update public.orders set delivery_address = '변조' where id = 'e5000000-0000-0000-0000-0000000000b1'$q$) = 0);
select pg_temp.expect('A 사장이 B의 주문을 DELETE 하면 0행(또는 거부)',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', $q$delete from public.orders where id = 'e5000000-0000-0000-0000-0000000000b1'$q$) <= 0);
select pg_temp.expect('고객 R2가 R1의 주문을 UPDATE 하면 0행',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f2', $q$update public.orders set delivery_address = '변조' where id = 'e5000000-0000-0000-0000-0000000000a1'$q$) = 0);
select pg_temp.expect('고객 R2가 R1 명의로 주문 INSERT 하면 거부(-1)',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f2', $q$insert into public.orders (order_number, wholesaler_id, retailer_id, delivery_address, total_amount) values ('ISO-FAKE', 'e2000000-0000-0000-0000-0000000000a1', 'e3000000-0000-0000-0000-0000000000f1', '위조', 1)$q$) = -1);
select pg_temp.expect('고객 R2가 거래 없는 공급사(B) 몫으로 주문 INSERT 하면 거부(-1)',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f2', $q$insert into public.orders (order_number, wholesaler_id, retailer_id, delivery_address, total_amount) values ('ISO-FAKE2', 'e2000000-0000-0000-0000-0000000000b1', 'e3000000-0000-0000-0000-0000000000f2', '위조', 1)$q$) = -1);
select pg_temp.expect('고객 R1이 R2 몫의 맞춤단가를 만들 수 없다(공급사 소유 표라 거부)',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f1', $q$update public.custom_prices set custom_price = 1$q$) = 0);
select pg_temp.expect('고객 R2가 남의 맞춤단가를 UPDATE 하면 0행',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f2', $q$update public.custom_prices set custom_price = 1$q$) = 0);

-- ───────────── 소유 컬럼 없는 자식 표(업로드 행)도 부모 작업을 통해 격리된다 ─────────────
select pg_temp.expect('A 사장: 업로드 행은 자기 작업의 2건만(소유 컬럼 없는 표)',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', 'select count(*) from public.inbound_import_rows') = 2);
select pg_temp.expect('B 사장: 업로드 행은 자기 작업의 1건만',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000b', 'select count(*) from public.inbound_import_rows') = 1);
select pg_temp.expect('고객 R1은 공급사 업로드 작업·행을 못 본다',
    pg_temp.count_as('e1000000-0000-0000-0000-0000000000f1', 'select count(*) from public.inbound_import_rows') = 0
    and pg_temp.count_as('e1000000-0000-0000-0000-0000000000f1', 'select count(*) from public.inbound_import_jobs') = 0);
select pg_temp.expect('A 사장이 B 작업의 행을 UPDATE 하면 0행',
    pg_temp.count_as('e1000000-0000-0000-0000-00000000000a', $q$update public.inbound_import_rows set trace_no = '변조' where job_id = 'e6000000-0000-0000-0000-0000000000b1'$q$) = 0);
