-- 193: 쪼개기(가공) — 지육·대분할육 박스 1개 → 부위 박스 N개. docs/stock-redesign-boxes-and-conditions.md §3-2.
-- 재고(recalc_product_stock·원장 합계·배정)는 건드리지 않는다. 자식 박스마다 상품을 하나 골라 두므로
-- 지금의 "박스 하나 = 상품 하나" 구조 그대로 원장에 기록된다(부모 상품 SPLIT_OUT, 자식 상품 SPLIT_IN).
-- 부모는 status를 바꾸지 않고 잔량 0 + split_at으로 표시한다 — status 값을 늘리면 화면 목록 전부가 영향받는다.

alter table public.inbound_scans
    add column if not exists split_at   timestamptz,
    add column if not exists split_loss numeric(10, 3);

comment on column public.inbound_scans.split_at is '쪼개기로 소진된 시각(부모 박스). 이 값이 있으면 자식은 parent_scan_id로 찾는다';
comment on column public.inbound_scans.split_loss is '쪼개기 수율 손실 = 쪼개기 당시 부모 잔량 − 자식 중량 합(뼈·지방·손실)';

create index if not exists idx_inbound_scans_parent on public.inbound_scans (parent_scan_id) where parent_scan_id is not null;

alter table public.stock_ledger drop constraint if exists stock_ledger_event_type_check;
alter table public.stock_ledger
    add constraint stock_ledger_event_type_check
    check (event_type = any (array[
        'INBOUND', 'INBOUND_VOID', 'OPENING_BALANCE', 'ORDER_OUT', 'ORDER_RESTORE',
        'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN', 'ADJUSTMENT', 'LOSS', 'SPLIT_OUT', 'SPLIT_IN'
    ]));

-- p_lines: [{"product_id": "...", "weight": 12.5}, ...]  자식 박스 하나당 한 줄(같은 상품이 여러 줄이어도 된다).
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
    v_total         numeric(10, 3) := 0;
    v_loss          numeric(10, 3);
    v_child_id      uuid;
    v_children      uuid[] := '{}';
    v_product_ids   uuid[] := '{}';
    v_pid           uuid;
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

    -- 줄 검증 먼저(쓰기 전에 전부 거른다).
    for v_line in select * from jsonb_array_elements(p_lines) loop
        v_idx := v_idx + 1;

        begin
            v_weight := (v_line ->> 'weight')::numeric;
            v_product_id := (v_line ->> 'product_id')::uuid;
        exception when others then
            raise exception 'INVALID_SPLIT_LINE:%', v_idx;
        end;

        if v_weight is null or v_weight <= 0 or v_product_id is null then
            raise exception 'INVALID_SPLIT_LINE:%', v_idx;
        end if;

        select * into v_product from public.products where id = v_product_id and wholesaler_id = v_wholesaler_id;

        if v_product.id is null then
            raise exception 'PRODUCT_NOT_FOUND:%', v_idx;
        end if;

        if v_product.unit is distinct from v_parent.unit then
            raise exception 'PRODUCT_UNIT_MISMATCH:%', v_idx;
        end if;

        v_total := v_total + v_weight;
    end loop;

    if v_total > v_parent.remaining_weight then
        raise exception 'CHILDREN_EXCEED_PARENT:%:%', v_total, v_parent.remaining_weight;
    end if;

    v_loss := v_parent.remaining_weight - v_total;

    -- 기초재고 이관은 첫 원장 행 전에(ensure_opening_balance 규칙). 관련 상품 전부.
    select coalesce(array_agg(distinct x), '{}') into v_product_ids
      from (
            select v_parent.product_id as x
            union
            select (e ->> 'product_id')::uuid from jsonb_array_elements(p_lines) e
           ) t;

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
    for v_line in select * from jsonb_array_elements(p_lines) loop
        v_weight := (v_line ->> 'weight')::numeric;
        v_product_id := (v_line ->> 'product_id')::uuid;

        insert into public.inbound_scans (
            wholesaler_id, trace_no, product_id, weight, unit, scan_type, status, remaining_weight,
            best_before, storage_location, storage_location_photo_path, scanned_by,
            parent_scan_id, memo
        ) values (
            v_wholesaler_id, v_parent.trace_no, v_product_id, v_weight, v_parent.unit, 'MANUAL', 'NORMAL', v_weight,
            v_parent.best_before, v_parent.storage_location, v_parent.storage_location_photo_path, auth.uid(),
            v_parent.id, '쪼개기'
        ) returning id into v_child_id;

        insert into public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) values (
            v_wholesaler_id, v_product_id, v_child_id, v_weight,
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
        'loss', v_loss
    );
end;
$$;

revoke all on function public.split_inbound_scan(uuid, jsonb) from public, anon;
grant execute on function public.split_inbound_scan(uuid, jsonb) to authenticated, service_role;
