-- 읽기 격리 전수 점검. 로컬 Docker DB 전용(읽기만, 롤백). 실행:
--   (echo "begin;"; cat scripts/db-test-read-isolation.sql; echo "rollback;") | docker exec -i supabase_db_wholesale psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -
-- 1) 공급사 계정: wholesaler_id가 있는 모든 표에서 "남의 공급사 행"이 한 줄이라도 보이면 누출.
-- 2) 고객 계정: retailer_id가 있는 모든 표에서 "남의 고객 행"이 보이면 누출.
-- 로컬 DB에 남은 여러 공급사·고객 데이터를 쓴다. 표마다 "남의 행이 실제로 존재했는지"(=검사가 의미 있었는지)를 같이 센다.
\set ON_ERROR_STOP on

do $$
declare
    w record; r record; t record;
    v_exist bigint; v_vis bigint;
    v_leaks text := '';
    v_checked integer := 0; v_meaningful integer := 0;
    v_meaningful_tables text[] := '{}';
begin
    -- ───── 1) 공급사 계정 ─────
    for w in
        select ws.id, ws.profile_id from public.wholesalers ws
         where ws.profile_id is not null
         order by (select count(*) from public.inbound_scans s where s.wholesaler_id = ws.id) desc, ws.created_at
         limit 5
    loop
        for t in
            select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              join pg_attribute a on a.attrelid = c.oid and a.attname = 'wholesaler_id' and not a.attisdropped
             where n.nspname = 'public' and c.relkind = 'r' order by 1
        loop
            -- 슈퍼유저로 "남의 행이 존재하는지"
            execute format('select count(*) from public.%I where wholesaler_id is not null and wholesaler_id <> %L', t.relname, w.id) into v_exist;

            perform set_config('request.jwt.claims', json_build_object('sub', w.profile_id, 'role', 'authenticated')::text, true);
            execute 'set local role authenticated';
            execute format('select count(*) from public.%I where wholesaler_id is not null and wholesaler_id <> %L', t.relname, w.id) into v_vis;
            execute 'reset role';

            v_checked := v_checked + 1;

            if v_exist > 0 then
                v_meaningful := v_meaningful + 1;
                if not (t.relname = any (v_meaningful_tables)) then v_meaningful_tables := v_meaningful_tables || t.relname; end if;
            end if;

            if v_vis > 0 then
                v_leaks := v_leaks || format('[공급사 %s → %s: 남의 행 %s건 보임(존재 %s)] ', left(w.id::text, 8), t.relname, v_vis, v_exist);
            end if;
        end loop;
    end loop;

    -- ───── 2) 고객 계정 ─────
    for r in
        select rt.id, rt.profile_id from public.retailers rt
         where rt.profile_id is not null
         order by (select count(*) from public.orders o where o.retailer_id = rt.id) desc
         limit 5
    loop
        for t in
            select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              join pg_attribute a on a.attrelid = c.oid and a.attname = 'retailer_id' and not a.attisdropped
             where n.nspname = 'public' and c.relkind = 'r' order by 1
        loop
            execute format('select count(*) from public.%I where retailer_id is not null and retailer_id <> %L', t.relname, r.id) into v_exist;

            perform set_config('request.jwt.claims', json_build_object('sub', r.profile_id, 'role', 'authenticated')::text, true);
            execute 'set local role authenticated';
            execute format('select count(*) from public.%I where retailer_id is not null and retailer_id <> %L', t.relname, r.id) into v_vis;
            execute 'reset role';

            v_checked := v_checked + 1;

            if v_exist > 0 then
                v_meaningful := v_meaningful + 1;
                if not (('고객:' || t.relname) = any (v_meaningful_tables)) then v_meaningful_tables := v_meaningful_tables || ('고객:' || t.relname); end if;
            end if;

            if v_vis > 0 then
                v_leaks := v_leaks || format('[고객 %s → %s: 남의 행 %s건 보임(존재 %s)] ', left(r.id::text, 8), t.relname, v_vis, v_exist);
            end if;
        end loop;
    end loop;

    raise notice '검사 %건, 그중 남의 행이 실제 존재해 의미 있던 검사 %건', v_checked, v_meaningful;
    raise notice '의미 있게 검사된 표: %', array_to_string(v_meaningful_tables, ', ');

    if v_leaks <> '' then
        raise exception 'FAIL: 읽기 격리 누출 — %', v_leaks;
    end if;

    raise notice 'PASS: 공급사·고객 계정 모두 남의 행이 보이는 표 없음';
end $$;
