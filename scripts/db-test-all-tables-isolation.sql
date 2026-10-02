-- 전 테이블 읽기·쓰기 격리 전수 점검 — 카탈로그 기반 자동 시드 + 교차 공격. 로컬 Docker DB 전용, 전부 롤백. 실행:
--   (echo "begin;"; cat scripts/db-test-all-tables-isolation.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- 1) wholesaler_id가 있는 모든 표에 공급사 A·B 행을 자동 시드한다(NOT NULL 컬럼은 타입·FK·CHECK 리터럴로 채움, FK는 같은 공급사의 부모 행으로).
-- 2) A 계정으로: B 행 조회 0건 / B 행 UPDATE·DELETE 0행 / B 소유 행 INSERT 거부여야 한다.
-- 3) 고객 R1(두 공급사 거래)·R2(무거래): retailer_id가 있는 모든 표에서 R2가 R1 행을 못 보고 못 바꾸는지.
-- 자동 시드가 안 되는 표는 조용히 넘기지 않고 목록으로 실패시킨다 → OVERRIDES에 값을 적거나 KNOWN_UNSEEDABLE에 사유를 적는다.
\set ON_ERROR_STOP on

-- ───────────── 수동 보정 ─────────────
-- 'table.column' → SQL 리터럴 텍스트(자동 생성이 CHECK·형식 때문에 실패하는 컬럼)
create temp table _overrides (k text primary key, v text);
-- 값에 {tenant}를 쓰면 시드 대상 공급사 id로 바뀐다. 이 목록에 있는 컬럼은 NULL 허용이어도 반드시 채운다.
insert into _overrides values
    ('wholesalers.business_number', '1110000093'),
    ('orders.total_amount', '100000'),                                   -- 최소 주문 금액 트리거(MIN_ORDER_AMOUNT)
    ('outbound_sms_queue.message_type', 'retailer_invite'),             -- 유형별 필수 참조가 다른 다중 컬럼 CHECK
    ('outbound_sms_queue.retailer_id', 'c2000000-0000-0000-0000-0000000000f1'),
    ('supplier_statement_files.storage_path', '{tenant}/probe.pdf');    -- 경로가 자기 공급사 폴더여야 하는 CHECK

-- 자동 시드를 못 하는 표와 이유(사유 없이 넣지 않는다). 이 표들은 읽기·쓰기 격리를 다른 스크립트가 시나리오로 검증해야 한다.
create temp table _known_unseedable (tbl text primary key, why text);

-- ───────────── 준비: 공급사 A·B, 고객 R1·R2 ─────────────
insert into auth.users (id, email) values
    ('c0000000-0000-0000-0000-00000000000a', 'xa@t.com'), ('c0000000-0000-0000-0000-00000000000b', 'xb@t.com'),
    ('c0000000-0000-0000-0000-0000000000f1', 'xr1@t.com'), ('c0000000-0000-0000-0000-0000000000f2', 'xr2@t.com');
alter table public.profiles disable trigger user;
insert into public.profiles (id, role, name, phone) values
    ('c0000000-0000-0000-0000-00000000000a', 'wholesaler', 'XA', '010'), ('c0000000-0000-0000-0000-00000000000b', 'wholesaler', 'XB', '011'),
    ('c0000000-0000-0000-0000-0000000000f1', 'retailer', 'XR1', '012'), ('c0000000-0000-0000-0000-0000000000f2', 'retailer', 'XR2', '013')
    on conflict (id) do update set role = excluded.role;
alter table public.profiles enable trigger user;
insert into public.wholesalers (id, profile_id, business_name, business_number, representative_name, status) values
    ('c1000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a', 'XA축', '1110000085', 'A', 'active'),
    ('c1000000-0000-0000-0000-0000000000b1', 'c0000000-0000-0000-0000-00000000000b', 'XB축', '1110000093', 'B', 'active');
insert into public.retailers (id, profile_id, restaurant_name, representative_name, delivery_address) values
    ('c2000000-0000-0000-0000-0000000000f1', 'c0000000-0000-0000-0000-0000000000f1', '식당1', 'R1', '주소1'),
    ('c2000000-0000-0000-0000-0000000000f2', 'c0000000-0000-0000-0000-0000000000f2', '식당2', 'R2', '주소2');
insert into public.wholesaler_retailers (wholesaler_id, retailer_id, status) values
    ('c1000000-0000-0000-0000-0000000000a1', 'c2000000-0000-0000-0000-0000000000f1', 'active'),
    ('c1000000-0000-0000-0000-0000000000a1', 'c2000000-0000-0000-0000-0000000000f2', 'active'),
    ('c1000000-0000-0000-0000-0000000000b1', 'c2000000-0000-0000-0000-0000000000f1', 'active');

-- ───────────── 자동 시드 함수 ─────────────
create or replace function pg_temp.pick_parent(p_parent regclass, p_col name, p_tenant uuid, p_depth int) returns text language plpgsql as $$
declare v text; v_sql text; v_has_w boolean;
begin
    if p_parent = 'public.profiles'::regclass then
        select quote_literal(profile_id::text) into v from public.wholesalers where id = p_tenant;
        if v is null then select quote_literal(id::text) into v from public.profiles limit 1; end if;
        return v;
    elsif p_parent = 'public.wholesalers'::regclass then
        return quote_literal(p_tenant::text);
    elsif p_parent = 'public.retailers'::regclass then
        return quote_literal('c2000000-0000-0000-0000-0000000000f1');
    elsif p_parent = 'auth.users'::regclass then
        select quote_literal(profile_id::text) into v from public.wholesalers where id = p_tenant;
        return v;
    end if;

    v_has_w := exists (select 1 from pg_attribute where attrelid = p_parent and attname = 'wholesaler_id' and not attisdropped);

    if v_has_w and p_tenant is not null then
        execute format('select %I::text from %s where wholesaler_id = %L limit 1', p_col, p_parent, p_tenant) into v;
    else
        execute format('select %I::text from %s limit 1', p_col, p_parent) into v;
    end if;

    if v is null then
        v_sql := pg_temp.build_insert(p_parent, case when v_has_w then p_tenant end, p_depth);
        execute v_sql || format(' returning %I::text', p_col) into v;
    end if;

    return quote_literal(v);
end $$;

create or replace function pg_temp.build_insert(p_tbl regclass, p_tenant uuid, p_depth int default 0) returns text language plpgsql as $$
declare c record; v_cols text[] := '{}'; v_vals text[] := '{}'; v_val text; v_fk record; v_hint text; v_override text; v_tname text;
begin
    if p_depth > 4 then raise exception 'SEED_DEPTH:%', p_tbl; end if;
    v_tname := regexp_replace(p_tbl::text, '^public\.', '');

    for c in
        select a.attnum, a.attname, a.attnotnull, a.atthasdef, a.attidentity, a.atttypmod, t.typname, t.typcategory, t.oid as typoid
          from pg_attribute a join pg_type t on t.oid = a.atttypid
         where a.attrelid = p_tbl and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
         order by a.attnum
    loop
        if c.attname = 'wholesaler_id' and p_tenant is not null then
            v_cols := v_cols || quote_ident(c.attname);
            v_vals := v_vals || (quote_literal(p_tenant::text) || '::uuid');
            continue;
        end if;

        if c.attidentity <> '' then continue; end if;   -- identity 컬럼은 DB가 채운다

        select v into v_override from _overrides where k = v_tname || '.' || c.attname;

        if not ((c.attnotnull and not c.atthasdef) or v_override is not null) then continue; end if;

        if v_override is not null then
            v_val := quote_literal(replace(v_override, '{tenant}', coalesce(p_tenant::text, ''))) || '::' || format_type(c.typoid, c.atttypmod);
        else
            v_fk := null;
            select k.confrelid::regclass as parent, af.attname as refcol into v_fk
              from pg_constraint k join pg_attribute af on af.attrelid = k.confrelid and af.attnum = k.confkey[1]
             where k.conrelid = p_tbl and k.contype = 'f' and array_length(k.conkey, 1) = 1 and k.conkey[1] = c.attnum limit 1;

            if v_fk.parent is not null then
                v_val := pg_temp.pick_parent(v_fk.parent, v_fk.refcol, p_tenant, p_depth + 1) || '::' || format_type(c.typoid, c.atttypmod);
            else
                -- 이 컬럼만 대상인 CHECK 제약 안의 첫 문자열 리터럴(status in ('a','b') 같은 것)
                select (regexp_match(pg_get_constraintdef(k.oid), '''([^'']+)''::'))[1] into v_hint
                  from pg_constraint k where k.conrelid = p_tbl and k.contype = 'c' and k.conkey = array[c.attnum::smallint] limit 1;

                v_val := case
                    when c.typcategory = 'E' then quote_literal((select enumlabel from pg_enum where enumtypid = c.typoid order by enumsortorder limit 1)) || '::' || format_type(c.typoid, c.atttypmod)
                    when c.typcategory = 'A' then quote_literal('{}') || '::' || format_type(c.typoid, c.atttypmod)
                    when c.typname = 'uuid' then quote_literal(gen_random_uuid()::text) || '::uuid'
                    when c.typname in ('text', 'varchar', 'bpchar') then quote_literal(coalesce(v_hint, 'iso' || substr(md5(random()::text), 1, 10))) || '::' || format_type(c.typoid, c.atttypmod)
                    when c.typname in ('int2', 'int4', 'int8', 'numeric', 'float4', 'float8') then quote_literal('1') || '::' || format_type(c.typoid, c.atttypmod)
                    when c.typname = 'bool' then 'false'
                    when c.typname = 'date' then 'current_date'
                    when c.typname in ('timestamptz', 'timestamp') then 'now()'
                    when c.typname in ('jsonb', 'json') then quote_literal('{}') || '::' || c.typname
                    when c.typname = 'interval' then quote_literal('1 day') || '::interval'
                    when c.typname = 'bytea' then quote_literal('\x00') || '::bytea'
                    else null
                end;

                if v_val is null then raise exception 'SEED_TYPE:%.% (%)', v_tname, c.attname, c.typname; end if;
            end if;
        end if;

        v_cols := v_cols || quote_ident(c.attname);
        v_vals := v_vals || v_val;
    end loop;

    if cardinality(v_cols) = 0 then
        return format('insert into %s default values', p_tbl);
    end if;

    return format('insert into %s (%s) values (%s)', p_tbl, array_to_string(v_cols, ', '), array_to_string(v_vals, ', '));
end $$;

-- ───────────── 본 점검 ─────────────
do $$
declare
    wa constant uuid := 'c1000000-0000-0000-0000-0000000000a1';
    wb constant uuid := 'c1000000-0000-0000-0000-0000000000b1';
    pa constant uuid := 'c0000000-0000-0000-0000-00000000000a';
    t record; w uuid; v_sql text; v_n bigint; v_own bigint; v_other bigint;
    v_unseeded text := '';  v_leaks text := ''; v_ownblind text := ''; v_tables int := 0; v_meaningful int := 0;
    v_known text;
begin
    for t in
        select c.oid::regclass as tbl, c.relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'wholesaler_id' and not a.attisdropped
         where n.nspname = 'public' and c.relkind = 'r' order by c.relname
    loop
        v_tables := v_tables + 1;

        -- (1) 시드: 공급사마다 행이 하나도 없으면 자동 생성
        foreach w in array array[wa, wb] loop
            execute format('select count(*) from %s where wholesaler_id = %L', t.tbl, w) into v_n;

            if v_n = 0 then
                begin
                    execute pg_temp.build_insert(t.tbl, w);
                exception when others then
                    select why into v_known from _known_unseedable where tbl = t.relname;
                    if v_known is null then v_unseeded := v_unseeded || format('[%s: %s] ', t.relname, left(sqlerrm, 90)); end if;
                    exit;
                end;
            end if;
        end loop;

        -- (2) A 계정 시점 공격
        execute format('select count(*) from %s where wholesaler_id = %L', t.tbl, wa) into v_own;
        execute format('select count(*) from %s where wholesaler_id = %L', t.tbl, wb) into v_other;

        if v_own = 0 or v_other = 0 then continue; end if;  -- 시드 실패 표는 위에서 보고됨

        perform set_config('request.jwt.claims', json_build_object('sub', pa, 'role', 'authenticated')::text, true);
        execute 'set local role authenticated';

        begin
            execute format('select count(*) from %s where wholesaler_id = %L', t.tbl, wb) into v_n;
            if v_n > 0 then v_leaks := v_leaks || format('[읽기 누출 %s: B 행 %s건 보임] ', t.relname, v_n); end if;

            execute format('select count(*) from %s where wholesaler_id = %L', t.tbl, wa) into v_n;
            if v_n = 0 then v_ownblind := v_ownblind || t.relname || ' '; else v_meaningful := v_meaningful + 1; end if;
        exception
            when insufficient_privilege then
                -- 일반 사용자에게 표 권한 자체를 주지 않은 표(예: 기능 켜짐 이력 wholesaler_feature_periods, 마이그레이션 210)는
                -- 읽기가 통째로 막혀 있으니 남의 행이 보일 수 없다 — 격리가 지켜진 것으로 본다.
                null;
            when others then
                v_leaks := v_leaks || format('[읽기 오류 %s: %s] ', t.relname, left(sqlerrm, 60));
        end;

        begin
            execute format('update %s set wholesaler_id = wholesaler_id where wholesaler_id = %L', t.tbl, wb);
            get diagnostics v_n = row_count;
            if v_n > 0 then v_leaks := v_leaks || format('[수정 누출 %s: B 행 %s건 UPDATE됨] ', t.relname, v_n); end if;
        exception when others then null;  -- 거부(권한·정책·트리거)는 정상
        end;

        begin
            execute format('delete from %s where wholesaler_id = %L', t.tbl, wb);
            get diagnostics v_n = row_count;
            if v_n > 0 then v_leaks := v_leaks || format('[삭제 누출 %s: B 행 %s건 DELETE됨] ', t.relname, v_n); end if;
        exception
            -- FK 오류는 정책이 삭제를 이미 통과시켰다는 뜻이다(막았다면 0행이라 FK 검사까지 안 간다).
            when foreign_key_violation then v_leaks := v_leaks || format('[삭제 누출 %s: 정책은 통과, 참조 FK에서만 막힘] ', t.relname);
            when others then null;
        end;

        execute 'reset role';

        -- 삽입 공격: B 소유 행을 A 계정으로 INSERT (SQL은 슈퍼유저로 만들고 실행만 A로)
        begin
            v_sql := pg_temp.build_insert(t.tbl, wb);
        exception when others then
            v_sql := null;
        end;

        if v_sql is not null then
            perform set_config('request.jwt.claims', json_build_object('sub', pa, 'role', 'authenticated')::text, true);
            execute 'set local role authenticated';

            begin
                execute v_sql;
                v_leaks := v_leaks || format('[삽입 누출 %s: A 계정이 B 소유 행을 INSERT함] ', t.relname);
            exception when others then null;
            end;

            execute 'reset role';
        end if;
    end loop;

    raise notice '공급사 소유 표 %개 점검, 그중 A 자신의 행이 보여 의미 있게 검사된 표 %개', v_tables, v_meaningful;
    raise notice 'A 자신의 행도 안 보이는 표(설계상 서버 전용이면 정상, 아니면 검토): %', coalesce(nullif(v_ownblind, ''), '없음');

    if v_unseeded <> '' then
        raise exception 'FAIL: 자동 시드 불가 표(OVERRIDES에 값을 추가하거나 KNOWN_UNSEEDABLE에 사유를 적으세요): %', v_unseeded;
    end if;

    if v_leaks <> '' then
        raise exception 'FAIL: 격리 누출 — %', v_leaks;
    end if;

    raise notice 'PASS: 공급사 소유 표 전부 — 남의 행 조회 0·수정 0·삭제 0·삽입 거부';
end $$;

-- ───────────── 고객 쪽 전수: retailer_id가 있는 모든 표에서 R2(R1과 무관한 고객)가 R1 행을 못 보고 못 바꾼다 ─────────────
-- 위에서 자동 시드한 행 중 retailer_id가 R1인 것이 대상이다. R1 자신이 볼 수 있는 행이 있는 표만 "의미 있게 검사됨"으로 센다.
do $$
declare
    r1 constant uuid := 'c2000000-0000-0000-0000-0000000000f1';
    p1 constant uuid := 'c0000000-0000-0000-0000-0000000000f1';
    p2 constant uuid := 'c0000000-0000-0000-0000-0000000000f2';
    t record; v_exist bigint; v_r1_sees bigint; v_n bigint;
    v_leaks text := ''; v_meaningful int := 0; v_tables int := 0; v_noseed text := ''; v_r1blind text := '';
begin
    for t in
        select c.oid::regclass as tbl, c.relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'retailer_id' and not a.attisdropped
         where n.nspname = 'public' and c.relkind = 'r' order by c.relname
    loop
        v_tables := v_tables + 1;
        execute format('select count(*) from %s where retailer_id = %L', t.tbl, r1) into v_exist;

        if v_exist = 0 then
            v_noseed := v_noseed || t.relname || ' ';
            continue;
        end if;

        -- R1 자신의 시점(대조군)
        perform set_config('request.jwt.claims', json_build_object('sub', p1, 'role', 'authenticated')::text, true);
        execute 'set local role authenticated';
        begin
            execute format('select count(*) from %s where retailer_id = %L', t.tbl, r1) into v_r1_sees;
        exception when others then v_r1_sees := -1;
        end;
        execute 'reset role';

        if v_r1_sees > 0 then v_meaningful := v_meaningful + 1; else v_r1blind := v_r1blind || t.relname || ' '; end if;

        -- R2 시점(공격)
        perform set_config('request.jwt.claims', json_build_object('sub', p2, 'role', 'authenticated')::text, true);
        execute 'set local role authenticated';

        begin
            execute format('select count(*) from %s where retailer_id = %L', t.tbl, r1) into v_n;
            if v_n > 0 then v_leaks := v_leaks || format('[고객 읽기 누출 %s: R1 행 %s건 보임] ', t.relname, v_n); end if;
        exception when others then null;
        end;

        begin
            execute format('update %s set retailer_id = retailer_id where retailer_id = %L', t.tbl, r1);
            get diagnostics v_n = row_count;
            if v_n > 0 then v_leaks := v_leaks || format('[고객 수정 누출 %s: R1 행 %s건 UPDATE됨] ', t.relname, v_n); end if;
        exception when others then null;
        end;

        begin
            execute format('delete from %s where retailer_id = %L', t.tbl, r1);
            get diagnostics v_n = row_count;
            if v_n > 0 then v_leaks := v_leaks || format('[고객 삭제 누출 %s: R1 행 %s건 DELETE됨] ', t.relname, v_n); end if;
        exception
            when foreign_key_violation then v_leaks := v_leaks || format('[고객 삭제 누출 %s: 정책은 통과, 참조 FK에서만 막힘] ', t.relname);
            when others then null;
        end;

        execute 'reset role';
    end loop;

    raise notice '고객 소유 컬럼(retailer_id) 표 %개 점검, 그중 R1 자신의 행이 보여 의미 있게 검사된 표 %개', v_tables, v_meaningful;
    raise notice 'R1 행이 시드되지 않아 못 본 표: %', coalesce(nullif(v_noseed, ''), '없음');
    raise notice 'R1 행은 있으나 R1 자신도 못 보는 표(서버·공급사 전용이면 정상): %', coalesce(nullif(v_r1blind, ''), '없음');

    if v_leaks <> '' then
        raise exception 'FAIL: 고객 격리 누출 — %', v_leaks;
    end if;

    raise notice 'PASS: 고객 소유 컬럼 표 전부 — 무관한 고객(R2)의 조회 0·수정 0·삭제 0';
end $$;
