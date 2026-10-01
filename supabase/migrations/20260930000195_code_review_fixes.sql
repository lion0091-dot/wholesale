-- 195: 코드리뷰(2026-10-01) 지적 4건 수정.
--  1) 수입소 박스는 품종·등급이 원래 없다 — 쪼개기가 품종이 없다고 막던 것을 국내산일 때만 막고, 비교는 빈 값끼리 맞춘다.
--  2) 쪼갠 박스(자식)의 부위 꼬리표가 부모의 이력조회 부위(예: 수입육 '양지')로 덮어써지던 것 — 자식은 자기 상품의 부위를 지킨다.
--  3) 재고 보기 그림자 집계가 남은 중량 0인 박스까지 세던 것(박스 수 부풀림 + 상품×전 박스 교차 비용).
--  4) 입출고 내역 요약 카드가 쪼개기(SPLIT_OUT/IN)를 어느 칸에도 안 넣던 것 — 칸을 하나 더 둔다.

-- ───────────────────────── 1) 쪼개기: 수입소 품종 ─────────────────────────

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
    v_domestic boolean;
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
    -- 원산지를 모르면 국내산으로 보고 품종을 요구한다(한우·육우 오분류가 표시·법적 문제라 보수적으로).
    v_domestic := coalesce(v_origin, '국내산') = '국내산';

    if v_storage is null then
        raise exception 'PART_NEEDS_STORAGE';
    end if;

    if v_is_cattle then
        v_breed := coalesce(nullif(btrim(coalesce(p_parent.tag_breed, '')), ''), v_parent_product.breed);

        -- 수입소는 품종·등급 개념 자체가 없다(실제 조회로 확인) — 국내산일 때만 품종이 필수다.
        if v_breed is null and v_domestic then
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
       and (not v_is_cattle or coalesce(p.breed, '') = coalesce(v_breed, ''))
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
               and (not v_is_cattle or coalesce(p.breed, '') = coalesce(v_breed, ''))
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

-- ───────────────────────── 2) 쪼갠 박스는 자기 부위를 지킨다 ─────────────────────────

create or replace function public.trg_fill_inbound_scan_tags()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    t record;
    v_child_part text;
begin
    if tg_op = 'UPDATE'
       and new.trace_no is not distinct from old.trace_no
       and new.product_id is not distinct from old.product_id then
        return new;
    end if;

    select * into t from public.compute_inbound_scan_tags(new.trace_no, new.product_id);

    new.tag_species       := t.tag_species;
    new.tag_part          := t.tag_part;
    new.tag_origin        := t.tag_origin;
    new.tag_grade         := t.tag_grade;
    new.tag_grade_mix     := t.tag_grade_mix;
    new.tag_sex           := t.tag_sex;
    new.tag_bms           := t.tag_bms;
    new.tag_breed         := t.tag_breed;
    new.tag_storage_state := t.tag_storage_state;
    new.slaughter_from    := t.slaughter_from;
    new.slaughter_to      := t.slaughter_to;
    new.tag_source        := t.tag_source;

    -- 쪼개기로 생긴 박스는 이력번호가 부모와 같아 이력조회의 부위(수입육 '양지' 등)가 따라붙는다 — 자식의 부위는 썰어서 정한 자기 상품의 부위다.
    if new.parent_scan_id is not null and new.product_id is not null then
        select subcategory into v_child_part from public.products where id = new.product_id;

        if v_child_part is not null then
            new.tag_part := v_child_part;
            new.tag_source := coalesce(new.tag_source, '{}'::jsonb) || jsonb_build_object('part', 'product');
        end if;
    end if;

    return new;
end;
$$;

create or replace function public.trg_master_livestock_refresh_tags()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    update public.inbound_scans s
       set tag_species = x.tag_species,
           -- 쪼갠 박스(자식)는 이력조회 부위로 덮어쓰지 않는다.
           tag_part = case
                          when s.parent_scan_id is not null
                              then coalesce((select p.subcategory from public.products p where p.id = s.product_id), x.tag_part)
                          else x.tag_part
                      end,
           tag_origin = x.tag_origin,
           tag_grade = x.tag_grade, tag_grade_mix = x.tag_grade_mix, tag_sex = x.tag_sex,
           tag_bms = x.tag_bms, tag_breed = x.tag_breed, tag_storage_state = x.tag_storage_state,
           slaughter_from = x.slaughter_from, slaughter_to = x.slaughter_to, tag_source = x.tag_source
      from (
            select b.id, t.*
              from public.inbound_scans b
             cross join lateral public.compute_inbound_scan_tags(new.trace_no, b.product_id) t
             where b.trace_no = new.trace_no
           ) x
     where x.id = s.id;

    return new;
end;
$$;

revoke all on function public.trg_master_livestock_refresh_tags() from public, anon, authenticated;

-- 이미 있는 자식 박스의 부위 바로잡기(라이브에는 거의 없지만 안전하게).
update public.inbound_scans s
   set tag_part = p.subcategory
  from public.products p
 where s.parent_scan_id is not null
   and p.id = s.product_id
   and p.subcategory is not null
   and s.tag_part is distinct from p.subcategory;

-- ───────────────────────── 3) 그림자 집계: 남은 중량 0 박스 제외 ─────────────────────────

create or replace function public.shadow_box_stock(p_wholesaler_id uuid)
returns table(
    product_id uuid, product_name text, unit text,
    ledger_stock numeric,
    sure_weight numeric,
    sure_boxes integer,
    mixed_weight numeric,
    mixed_boxes integer,
    legacy_weight numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select p.id, p.name, p.unit, p.stock_quantity,
           coalesce(sum(s.remaining_weight) filter (where m.k = 'sure'), 0),
           (count(s.id) filter (where m.k = 'sure'))::integer,
           coalesce(sum(s.remaining_weight) filter (where m.k = 'mixed'), 0),
           (count(s.id) filter (where m.k = 'mixed'))::integer,
           coalesce((select sum(l.remaining_weight) from public.inbound_scans l
                      where l.product_id = p.id and l.status = 'NORMAL'), 0)
      from public.products p
      left join public.inbound_scans s
             on s.wholesaler_id = p.wholesaler_id and s.status = 'NORMAL' and s.remaining_weight > 0
      left join lateral (
            select public.box_matches_product(
                p.category, p.subcategory, p.origin, p.grade, p.sex, p.bms, p.breed, p.storage_state,
                s.tag_species, s.tag_part, s.tag_origin, s.tag_grade, s.tag_sex, s.tag_bms, s.tag_breed, s.tag_storage_state
            ) as k
      ) m on true
     where p.wholesaler_id = p_wholesaler_id
       and public.can_access_wholesaler(p_wholesaler_id)
     group by p.id, p.name, p.unit, p.stock_quantity
     order by p.name;
$$;

-- ───────────────────────── 4) 입출고 내역 요약: 쪼개기 칸 ─────────────────────────

drop function if exists public.summarize_stock_ledger(uuid, date, date, uuid, text);

create function public.summarize_stock_ledger(
    p_wholesaler_id uuid, p_from date default null, p_to date default null,
    p_product_id uuid default null, p_trace_no text default null
)
returns table(inbound_qty numeric, outbound_qty numeric, adjustment_qty numeric, loss_qty numeric, split_qty numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    SELECT
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN ('INBOUND', 'INBOUND_VOID', 'OPENING_BALANCE')), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN (
            'ORDER_OUT', 'ORDER_RESTORE', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN'
        )), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'ADJUSTMENT'), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'LOSS'), 0),
        -- 쪼개기는 박스 하나가 부위 박스 여러 개로 바뀌는 것이라 상품별로는 늘고 줄지만 입고·출고가 아니다.
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN ('SPLIT_OUT', 'SPLIT_IN')), 0)
    FROM public.stock_ledger l
    LEFT JOIN public.inbound_scans scan ON scan.id = l.inbound_scan_id
    WHERE l.wholesaler_id = p_wholesaler_id
      AND (p_from IS NULL OR l.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR l.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR l.product_id = p_product_id)
      AND (
            NULLIF(btrim(p_trace_no), '') IS NULL
         OR scan.trace_no ILIKE '%' || btrim(p_trace_no) || '%'
      )
      AND (
            public.can_access_wholesaler(p_wholesaler_id)
      );
$$;
