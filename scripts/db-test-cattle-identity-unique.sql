\set ON_ERROR_STOP on
-- 마이그레이션 121: 소 상품 정체성 유니크 인덱스 + 자동 생성 함수의 동시 충돌 처리.
-- 실행: docker exec -i supabase_db_wholesale psql -U postgres < scripts/db-test-cattle-identity-unique.sql (끝에서 ROLLBACK)
begin;

insert into auth.users (id,email) values ('11111111-1111-1111-1111-111111111111','a@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id,role,name,phone) values ('11111111-1111-1111-1111-111111111111','wholesaler','A','010')
 on conflict (id) do update set role=excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
 values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','A축산','1110000001','A');

create temp table t_result (n int, name text, ok boolean);

do $$
declare
    v_w uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
    v_dup_blocked boolean := false;
    v_bundle_ok boolean := false;
begin
    -- U1: 같은 (부위·등급·원산지)의 소 상품 두 번째는 거부된다
    insert into public.products (wholesaler_id,name,category,subcategory,grade,origin,base_price,unit,stock_quantity,is_active)
    values (v_w,'등심 1++','소','등심','1++','국내산',0,'kg',0,false);
    begin
        insert into public.products (wholesaler_id,name,category,subcategory,grade,origin,base_price,unit,stock_quantity,is_active)
        values (v_w,'등심 1++ 복사','소','등심','1++','국내산',0,'kg',0,false);
    exception when unique_violation then v_dup_blocked := true;
    end;
    insert into t_result values (1,'U1 같은 키 두 번째 소 상품은 unique_violation', v_dup_blocked);

    -- U2: 부위·등급이 다르면 다른 상품이라 허용
    insert into public.products (wholesaler_id,name,category,subcategory,grade,origin,base_price,unit,stock_quantity,is_active)
    values (v_w,'안심 1++','소','안심','1++','국내산',0,'kg',0,false),
           (v_w,'등심 1+','소','등심','1+','국내산',0,'kg',0,false),
           (v_w,'등심 1++ 수입','소','등심','1++','미국',0,'kg',0,false);
    insert into t_result values (2,'U2 부위·등급·원산지가 하나라도 다르면 허용', true);

    -- U3: 단위가 달라도 같은 키의 소 상품은 거부된다(세트 예외 없음 — 마이그레이션 122)
    v_bundle_ok := false;
    begin
        insert into public.products (wholesaler_id,name,category,subcategory,grade,origin,base_price,unit,stock_quantity,is_active)
        values (v_w,'등심 1++ 박스','소','등심','1++','국내산',0,'박스',0,false);
    exception when unique_violation then v_bundle_ok := true;
    end;
    insert into t_result values (3,'U3 단위가 달라도 같은 키는 unique_violation', v_bundle_ok);

    -- U4: 다른 공급사는 같은 키여도 허용 (인덱스가 공급사별)
    insert into auth.users (id,email) values ('22222222-2222-2222-2222-222222222222','b@t.com');
    alter table public.profiles disable trigger user;
    insert into public.profiles (id,role,name,phone) values ('22222222-2222-2222-2222-222222222222','wholesaler','B','010')
     on conflict (id) do update set role=excluded.role;
    alter table public.profiles enable trigger user;
    insert into public.wholesalers (id,profile_id,business_name,business_number,representative_name)
     values ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','B축산','1110000002','B');
    insert into public.products (wholesaler_id,name,category,subcategory,grade,origin,base_price,unit,stock_quantity,is_active)
    values ('aaaaaaaa-0000-0000-0000-000000000002','등심 1++','소','등심','1++','국내산',0,'kg',0,false);
    insert into t_result values (4,'U4 다른 공급사는 같은 키 상품 허용', true);

    -- U5: 소 외 축종은 영향 없음 (같은 부위·등급·원산지 돼지 상품 두 개 허용)
    insert into public.products (wholesaler_id,name,category,subcategory,grade,origin,base_price,unit,stock_quantity,is_active)
    values (v_w,'삼겹 A','돼지','삼겹살',null,'국내산',0,'kg',0,false),
           (v_w,'삼겹 B','돼지','삼겹살',null,'국내산',0,'kg',0,false);
    insert into t_result values (5,'U5 소 외 축종은 유니크 대상 아님', true);
end $$;

select n, name, case when ok then 'PASS' else 'FAIL' end as result from t_result order by n;
select case when count(*) filter (where not ok) = 0 then 'ALL PASS ('||count(*)||')' else 'FAILED' end as summary from t_result;

rollback;
