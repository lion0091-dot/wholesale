-- 소 성별(거세/암) + BMS(마블링 지수, 1++ 한정) + 냉장/냉동(계란 제외 전 축종) 정체성 — 마이그레이션 159 검증.
-- 로컬 Docker DB 전용. 실행(전부 롤백):
--   (echo "begin;"; cat scripts/db-test-cattle-sex-bms-storage.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
\set ON_ERROR_STOP on

create or replace function pg_temp.expect(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
    if p_ok is not true then
        raise exception 'FAIL: %', p_name;
    end if;
    raise notice 'PASS: %', p_name;
end $$;

insert into auth.users (id, email) values ('c2c2c2c2-0000-0000-0000-000000000001', 'sexbms@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values ('c2c2c2c2-0000-0000-0000-000000000001', 'wholesaler', 'A', '010')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name)
    values ('c2c2c2c2-0000-0000-0000-0000000000a1', 'c2c2c2c2-0000-0000-0000-000000000001', '성별축산', '1110000078', 'A');

grant execute on function public.upsert_master_livestock(text,text,text,jsonb,text,text,text,text,date,text,text,text,text,date,text,text) to authenticated;

-- ========== 1. DB 제약 — 정상 등록/CHECK/유니크 ==========
do $$
declare
    v_w uuid := 'c2c2c2c2-0000-0000-0000-0000000000a1';
begin
    insert into public.products (wholesaler_id,name,category,subcategory,grade,breed,sex,bms,storage_state,origin,base_price,unit,stock_quantity,is_active)
    values (v_w,'한우 등심 1++ 거세 (9)','소','등심','1++','한우','거세','9','냉장','국내산',0,'kg',0,false);
    perform pg_temp.expect('정상 등록(품종+부위+등급+성별+원산지+냉장+BMS)', true);

    insert into public.products (wholesaler_id,name,category,subcategory,grade,breed,sex,bms,storage_state,origin,base_price,unit,stock_quantity,is_active)
    values (v_w,'한우 등심 1++ 암 (9)','소','등심','1++','한우','암','9','냉장','국내산',0,'kg',0,false);
    perform pg_temp.expect('성별만 다른 조합도 별도 상품으로 등록 허용', true);
end $$;

do $$
declare
    v_w uuid := 'c2c2c2c2-0000-0000-0000-0000000000a1';
    v_blocked boolean := false;
begin
    begin
        insert into public.products (wholesaler_id,name,category,subcategory,grade,breed,sex,bms,storage_state,origin,base_price,unit,stock_quantity,is_active)
        values (v_w,'중복 시도','소','등심','1++','한우','거세','9','냉장','국내산',0,'kg',0,false);
    exception when unique_violation then v_blocked := true;
    end;
    perform pg_temp.expect('성별·BMS·냉장까지 완전히 같은 조합 재등록은 unique_violation', v_blocked);

    v_blocked := false;
    begin
        insert into public.products (wholesaler_id,name,category,subcategory,grade,breed,sex,bms,storage_state,origin,base_price,unit,stock_quantity,is_active)
        values (v_w,'BMS만 다름','소','등심','1++','한우','거세','7','냉장','국내산',0,'kg',0,false);
    exception when unique_violation then v_blocked := true;
    end;
    perform pg_temp.expect('BMS만 다르면 별도 상품(재고 단위)으로 허용', not v_blocked);

    v_blocked := false;
    begin
        insert into public.products (wholesaler_id,name,category,subcategory,grade,breed,sex,storage_state,origin,base_price,unit,stock_quantity,is_active)
        values (v_w,'냉동만 다름','소','등심','1++','한우','거세','냉동','국내산',0,'kg',0,false);
    exception when unique_violation then v_blocked := true;
    end;
    perform pg_temp.expect('냉장/냉동만 다르면 별도 상품으로 허용', not v_blocked);

    v_blocked := false;
    begin
        insert into public.products (wholesaler_id,name,category,subcategory,grade,breed,sex,bms,storage_state,origin,base_price,unit,stock_quantity,is_active)
        values (v_w,'등급오류','소','등심','1+','한우','거세','7','냉장','국내산',0,'kg',0,false);
    exception when check_violation then v_blocked := true;
    end;
    perform pg_temp.expect('BMS는 등급이 1++가 아니면 CHECK로 거부', v_blocked);

    v_blocked := false;
    begin
        insert into public.products (wholesaler_id,name,category,sex,origin,base_price,unit,stock_quantity,is_active)
        values (v_w,'돼지성별오류','돼지','거세','국내산',0,'kg',0,false);
    exception when check_violation then v_blocked := true;
    end;
    perform pg_temp.expect('성별은 소가 아니면 CHECK로 거부', v_blocked);

    v_blocked := false;
    begin
        insert into public.products (wholesaler_id,name,category,origin,storage_state,base_price,unit,stock_quantity,is_active)
        values (v_w,'계란냉장오류','계란','국내산','냉장',0,'개',0,false);
    exception when check_violation then v_blocked := true;
    end;
    perform pg_temp.expect('냉장/냉동은 계란이면 CHECK로 거부', v_blocked);
end $$;

-- ========== 2. 스캔 자동 생성 — 성별·BMS는 이력조회로 채워지고, 냉장/냉동은 항상 비워 사람이 채운다 ==========
do $$
declare
    v_scan_id uuid;
    v_result  jsonb;
    v_product record;
begin
    -- 1++ 개체, 거세, BMS 9 — 실제 API 응답 형태 그대로(insfat="9", sexNm="거세")
    perform public.upsert_master_livestock('009999990001','individual','mtrace_livestock','{}'::jsonb,'한우','소','안심','1++',current_date-1,'○○도축장',null,null,null,current_date,'거세','9');

    set role authenticated;
    set request.jwt.claim.sub = 'c2c2c2c2-0000-0000-0000-000000000001';

    v_result := public.record_inbound_scan('009999990001', 3.5, 'BARCODE_SCAN');
    v_scan_id := (v_result->>'scan_id')::uuid;

    reset role;
    set role authenticated;
    set request.jwt.claim.sub = 'c2c2c2c2-0000-0000-0000-000000000001';

    v_result := public.autocreate_product_for_scan(v_scan_id);
    select * into v_product from public.products where id = (v_result->>'product_id')::uuid;

    perform pg_temp.expect('스캔 자동 생성 — 성별은 이력조회 값(거세)으로 채워짐', v_product.sex = '거세');
    perform pg_temp.expect('스캔 자동 생성 — BMS는 이력조회 값(9)으로 채워짐(1++라서)', v_product.bms = '9');
    perform pg_temp.expect('스캔 자동 생성 — 냉장/냉동은 API에 없어 항상 비워둠', v_product.storage_state is null);
    perform pg_temp.expect('스캔 자동 생성 — 상품명에 성별·BMS 반영', v_product.name = '한우 안심 1++ 거세 (9)');

    reset role;
end $$;

do $$
declare
    v_scan_id uuid;
    v_result  jsonb;
    v_status  text;
begin
    -- 성별을 이력조회가 못 준 개체(묶음번호 등 일부 응답) — 품종과 달리 자동 생성을 막지 않는다.
    perform public.upsert_master_livestock('009999990002','individual','mtrace_livestock','{}'::jsonb,'한우','소','안심','1+',current_date-1,'○○도축장');

    set role authenticated;
    set request.jwt.claim.sub = 'c2c2c2c2-0000-0000-0000-000000000001';

    v_result := public.record_inbound_scan('009999990002', 3.0, 'BARCODE_SCAN');
    v_scan_id := (v_result->>'scan_id')::uuid;
    v_status := v_result->>'status';

    perform pg_temp.expect('성별 모르는 개체도 일단 PENDING_MAPPING(부위·등급까지는 정상)', v_status = 'PENDING_MAPPING');

    v_result := public.autocreate_product_for_scan(v_scan_id);
    perform pg_temp.expect('성별을 몰라도 자동 생성은 막지 않는다(품종과 다름, BREED_UNKNOWN 아님)', (v_result->>'created')::boolean = true);

    reset role;
end $$;

select '--- 결과: 예외 없이 여기까지 왔으면 전부 PASS ---' as summary;
