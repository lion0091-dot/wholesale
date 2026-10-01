-- 194: 쪼개기에서 줄마다 상품을 고르는 대신 "부위"만 고르면 상품이 자동으로 이어지게 한다(사장님 2026-10-01).
-- 부모 박스의 꼬리표(이력조회로 채워진 축종·품종·등급·성별·BMS·원산지·냉장/냉동)가 정체성 키를 이미 거의 다 갖고 있어
-- 부위만 새로 정하면 된다. 같은 키의 상품이 있으면 그것, 없으면 판매중지·가격 0으로 새로 만든다(autocreate_product_for_scan과 같은 규칙).
-- 줄은 {"part":"등심","weight":12.5} 또는 기존처럼 {"product_id":"...","weight":12.5} 둘 다 받는다.

-- 부위 → 상품. 내부용(split_inbound_scan만 부른다). 소·돼지만 자동 처리, 그 밖은 사람이 상품을 고르게 한다.
create or replace function public.split_resolve_product(p_wholesaler_id uuid, p_parent public.inbound_scans, p_part text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_parent_product public.products%rowtype;
    v_species  text;
    v_part     text := nullif(btrim(coalesce(p_part, '')), '');
    v_breed    text;
    v_grade    text;
    v_sex      text;
    v_bms      text;
    v_origin   text;
    v_storage  text;
    v_is_cattle boolean;
    v_uses_grade boolean;
    v_product_id uuid;
    v_name     text;
    v_created  boolean := false;
begin
    if v_part is null then
        raise exception 'PART_REQUIRED';
    end if;

    v_part := left(v_part, 40);

    select * into v_parent_product from public.products where id = p_parent.product_id;

    v_species := coalesce(nullif(btrim(coalesce(p_parent.tag_species, '')), ''), v_parent_product.category);

    if v_species is null or v_species not in ('소', '돼지') then
        raise exception 'PART_AUTORESOLVE_UNSUPPORTED';
    end if;

    v_is_cattle  := v_species = '소';
    v_uses_grade := v_is_cattle;

    -- 꼬리표가 진실(이력조회), 비어 있으면 부모 상품 값.
    v_origin  := coalesce(nullif(btrim(coalesce(p_parent.tag_origin, '')), ''), v_parent_product.origin);
    v_storage := coalesce(p_parent.tag_storage_state, case when v_parent_product.storage_state in ('냉장', '냉동') then v_parent_product.storage_state end);

    if v_storage is null then
        raise exception 'PART_NEEDS_STORAGE';
    end if;

    if v_is_cattle then
        v_breed := coalesce(nullif(btrim(coalesce(p_parent.tag_breed, '')), ''), v_parent_product.breed);

        if v_breed is null then
            raise exception 'PART_BREED_UNKNOWN';
        end if;

        -- 등급이 섞인 로트('혼합')는 등급 없는 상품(조건 NULL = 상관없음)으로 잇는다.
        v_grade := nullif(btrim(coalesce(p_parent.tag_grade, '')), '');
        if v_grade = '혼합' then
            v_grade := null;
        end if;
        v_grade := coalesce(v_grade, case when p_parent.tag_grade is null then v_parent_product.grade end);

        v_sex := coalesce(nullif(btrim(coalesce(p_parent.tag_sex, '')), ''), v_parent_product.sex);
        v_bms := case when v_grade = '1++' then coalesce(nullif(btrim(coalesce(p_parent.tag_bms, '')), ''), v_parent_product.bms) end;
    end if;

    select p.id into v_product_id
      from public.products p
     where p.wholesaler_id = p_wholesaler_id
       and p.category = v_species
       and coalesce(p.subcategory, '') = v_part
       and (not v_is_cattle or p.breed = v_breed)
       and (not v_uses_grade or coalesce(p.grade, '') = coalesce(v_grade, ''))
       and (not v_is_cattle or coalesce(p.sex, '') = coalesce(v_sex, ''))
       and (not v_is_cattle or coalesce(p.bms, '') = coalesce(v_bms, ''))
       and public.origin_matches(p.origin, v_origin)
       and p.storage_state = v_storage
     order by p.archived_at nulls first
     limit 1;

    if v_product_id is null then
        if v_is_cattle then
            v_name := btrim(concat_ws(' ', v_breed, v_part,
                case when v_bms is not null then v_grade || '(' || v_bms || ')' else v_grade end, v_sex));
        else
            v_name := v_part;
        end if;
        v_name := btrim(v_storage || ' ' || v_name);

        begin
            insert into public.products (
                wholesaler_id, name, category, subcategory, origin, grade, breed, sex, bms, storage_state,
                base_price, unit, stock_quantity, is_active, description, created_by
            ) values (
                p_wholesaler_id, v_name, v_species, v_part, v_origin,
                case when v_uses_grade then v_grade end,
                case when v_is_cattle then v_breed end,
                case when v_is_cattle then v_sex end,
                case when v_is_cattle then v_bms end,
                v_storage,
                0, coalesce(nullif(p_parent.unit, ''), 'kg'), 0,
                false,
                '쪼개기로 자동 등록됨 (이력번호 ' || p_parent.trace_no || ')',
                auth.uid()
            ) returning id into v_product_id;

            v_created := true;
        exception when unique_violation then
            -- 같은 정체성을 동시에 만든 다른 요청이 먼저 만들었다 — 그 상품을 쓴다.
            select p.id into v_product_id
              from public.products p
             where p.wholesaler_id = p_wholesaler_id
               and p.category = v_species
               and coalesce(p.subcategory, '') = v_part
               and (not v_is_cattle or p.breed = v_breed)
               and (not v_uses_grade or coalesce(p.grade, '') = coalesce(v_grade, ''))
               and (not v_is_cattle or coalesce(p.sex, '') = coalesce(v_sex, ''))
               and (not v_is_cattle or coalesce(p.bms, '') = coalesce(v_bms, ''))
               and public.origin_matches(p.origin, v_origin)
               and p.storage_state = v_storage
             limit 1;
        end;
    else
        update public.products set archived_at = null, updated_at = now()
         where id = v_product_id and archived_at is not null;
    end if;

    if v_product_id is null then
        raise exception 'PART_PRODUCT_UNRESOLVED';
    end if;

    return jsonb_build_object('product_id', v_product_id, 'created', v_created, 'name', (select name from public.products where id = v_product_id));
end;
$$;

revoke all on function public.split_resolve_product(uuid, public.inbound_scans, text) from public, anon, authenticated;

create or replace function public.split_inbound_scan(p_scan_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_wholesaler_id uuid;
    v_parent        public.inbound_scans%rowtype;
    v_line          jsonb;
    v_idx           integer := 0;
    v_weight        numeric(10, 3);
    v_product_id    uuid;
    v_product       public.products%rowtype;
    v_resolved      jsonb;
    v_total         numeric(10, 3) := 0;
    v_loss          numeric(10, 3);
    v_child_id      uuid;
    v_children      uuid[] := '{}';
    v_line_products uuid[] := '{}';
    v_line_weights  numeric[] := '{}';
    v_created_names text[] := '{}';
    v_product_ids   uuid[] := '{}';
    v_pid           uuid;
    i               integer;
begin
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    if v_wholesaler_id is null then
        raise exception 'NOT_A_SUPPLIER';
    end if;

    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
        raise exception 'NO_SPLIT_LINES';
    end if;

    if jsonb_array_length(p_lines) > 30 then
        raise exception 'TOO_MANY_SPLIT_LINES';
    end if;

    -- 박스를 먼저 잠근다(잠금 순서: 박스 → 상품, 099 설계 결정).
    select * into v_parent
      from public.inbound_scans
     where id = p_scan_id and wholesaler_id = v_wholesaler_id
       for update;

    if v_parent.id is null then
        raise exception 'SCAN_NOT_FOUND';
    end if;

    if v_parent.split_at is not null then
        raise exception 'ALREADY_SPLIT';
    end if;

    if v_parent.status <> 'NORMAL' or v_parent.product_id is null then
        raise exception 'SCAN_NOT_SPLITTABLE';
    end if;

    if v_parent.remaining_weight <= 0 then
        raise exception 'NOTHING_TO_SPLIT';
    end if;

    -- 줄 검증 + 상품 확정(부위만 온 줄은 여기서 상품을 찾거나 만든다. 어느 줄이든 실패하면 전부 롤백).
    for v_line in select * from jsonb_array_elements(p_lines) loop
        v_idx := v_idx + 1;

        begin
            v_weight := (v_line ->> 'weight')::numeric;
            v_product_id := nullif(v_line ->> 'product_id', '')::uuid;
        exception when others then
            raise exception 'INVALID_SPLIT_LINE:%', v_idx;
        end;

        if v_weight is null or v_weight <= 0 then
            raise exception 'INVALID_SPLIT_LINE:%', v_idx;
        end if;

        if v_product_id is null then
            if nullif(btrim(coalesce(v_line ->> 'part', '')), '') is null then
                raise exception 'INVALID_SPLIT_LINE:%', v_idx;
            end if;

            v_resolved := public.split_resolve_product(v_wholesaler_id, v_parent, v_line ->> 'part');
            v_product_id := (v_resolved ->> 'product_id')::uuid;

            if (v_resolved ->> 'created')::boolean and not (v_resolved ->> 'name' = any (v_created_names)) then
                v_created_names := v_created_names || (v_resolved ->> 'name');
            end if;
        end if;

        select * into v_product from public.products where id = v_product_id and wholesaler_id = v_wholesaler_id;

        if v_product.id is null then
            raise exception 'PRODUCT_NOT_FOUND:%', v_idx;
        end if;

        if v_product.unit is distinct from v_parent.unit then
            raise exception 'PRODUCT_UNIT_MISMATCH:%', v_idx;
        end if;

        v_line_products := v_line_products || v_product_id;
        v_line_weights := v_line_weights || v_weight;
        v_total := v_total + v_weight;
    end loop;

    if v_total > v_parent.remaining_weight then
        raise exception 'CHILDREN_EXCEED_PARENT:%:%', v_total, v_parent.remaining_weight;
    end if;

    v_loss := v_parent.remaining_weight - v_total;

    -- 기초재고 이관은 첫 원장 행 전에(ensure_opening_balance 규칙). 관련 상품 전부.
    select coalesce(array_agg(distinct x), '{}') into v_product_ids
      from (select v_parent.product_id as x union select unnest(v_line_products)) t;

    foreach v_pid in array v_product_ids loop
        perform public.ensure_opening_balance(v_pid);
    end loop;

    -- 부모: 남은 전량을 내보낸다.
    insert into public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) values (
        v_wholesaler_id, v_parent.product_id, v_parent.id, -v_parent.remaining_weight,
        'SPLIT_OUT', 'inbound_scan', v_parent.id, '쪼개기', auth.uid()
    );

    update public.inbound_scans
       set remaining_weight = 0, split_at = now(), split_loss = v_loss
     where id = v_parent.id;

    -- 자식: 이력번호·박스 정보는 부모 것, 중량·상품만 줄마다. 꼬리표는 삽입 트리거가 번호+상품으로 채운다.
    -- 매입 단가는 자식에 주지 않는다(부모가 이미 매입 정산에 잡혀 있어 이중 집계된다).
    for i in 1 .. array_length(v_line_products, 1) loop
        insert into public.inbound_scans (
            wholesaler_id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight,
            best_before, storage_location, storage_location_photo_path, scanned_by,
            parent_scan_id, memo
        ) values (
            v_wholesaler_id, v_parent.trace_no, v_line_products[i], v_line_weights[i], v_parent.unit, 'MANUAL', 'NORMAL', v_line_weights[i],
            v_parent.best_before, v_parent.storage_location, v_parent.storage_location_photo_path, auth.uid(),
            v_parent.id, '쪼개기'
        ) returning id into v_child_id;

        insert into public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) values (
            v_wholesaler_id, v_line_products[i], v_child_id, v_line_weights[i],
            'SPLIT_IN', 'inbound_scan', v_parent.id, '쪼개기', auth.uid()
        );

        v_children := v_children || v_child_id;
    end loop;

    -- 재고 캐시는 마지막에, 상품 id 순으로.
    foreach v_pid in array (select array_agg(x order by x) from unnest(v_product_ids) x) loop
        perform public.recalc_product_stock(v_pid);
    end loop;

    return jsonb_build_object(
        'parent_id', v_parent.id,
        'children', to_jsonb(v_children),
        'children_weight', v_total,
        'loss', v_loss,
        'created_products', to_jsonb(v_created_names)
    );
end;
$$;

revoke all on function public.split_inbound_scan(uuid, jsonb) from public, anon;
grant execute on function public.split_inbound_scan(uuid, jsonb) to authenticated, service_role;
