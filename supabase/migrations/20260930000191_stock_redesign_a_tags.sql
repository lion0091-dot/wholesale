-- 191: 재고 재설계 1단계(마이그 A) — 박스 꼬리표·로트 구성 요약. **동작 변화 없음.**
-- docs/stock-redesign-boxes-and-conditions.md §2-1, §5-1. 재고 집계·배정·입고 판정은 아직 옛 방식(product_id) 그대로다.
-- 여기서는 (1) 로트 구성 개체를 순회해 "같으면 값, 다르면 혼합"을 계산하는 함수, (2) master_livestock에 구성 요약,
-- (3) inbound_scans에 꼬리표 열 + 자동 채우기 트리거, (4) 기존 행 백필만 한다.
-- 로트의 master_livestock.grade(첫 개체 값 — 허위표시 원인)는 2단계에서 꼬리표로 대체될 때까지 그대로 둔다.

-- ───────────────────────── 1) 로트 구성 개체 순회 ─────────────────────────

-- 정부 응답 원문(raw_payload, XML→JSON 트리)에서 구성 개체(cattleNo/pigNo가 있는 노드)만 뽑는다.
-- 로트 머리 항목(lotNo·processPlaceNm만 있고 개체번호가 없는 것)은 빠진다. 소 로트의 개체번호는 '410'+12자리로 온다.
create or replace function public.lot_members(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'no',             coalesce(m ->> 'cattleNo', m ->> 'pigNo'),
        'grade',          nullif(btrim(coalesce(m ->> 'gradeNm', m ->> 'cattleGradeNm', m ->> 'qgradeNm', '')), ''),
        'bms',            nullif(btrim(coalesce(m ->> 'insfat', '')), ''),
        'species',        m ->> 'lsTypeNm',
        'breed',          public.trace_breed(m ->> 'lsTypeNm'),
        'slaughter',      case when (m ->> 'butcheryYmd') ~ '^\d{8}$'
                               then to_char(to_date(m ->> 'butcheryYmd', 'YYYYMMDD'), 'YYYY-MM-DD') end,
        'farm',           m ->> 'farmNm',
        'farm_addr',      m ->> 'farmAddr',
        'butchery_place', m ->> 'butcheryPlaceNm',
        'process_place',  m ->> 'processPlaceNm'
    ) order by coalesce(m ->> 'cattleNo', m ->> 'pigNo')), '[]'::jsonb)
    from jsonb_path_query(coalesce(p_payload, '{}'::jsonb),
                          'strict $.** ? (exists(@.cattleNo) || exists(@.pigNo))') as m;
$$;

-- 구성 개체 목록 → 로트 요약. 규칙(사장님 2026-10-01): 전부 같으면 그 값, 하나라도 다르면 '혼합'(등급)·null(BMS·품종). 대표값 금지.
create or replace function public.lot_summary(p_members jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
    with m as (
        select x ->> 'grade' as grade, x ->> 'bms' as bms, x ->> 'breed' as breed,
               (x ->> 'slaughter')::date as slaughter
        from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) as x
    ),
    g as (
        select count(*) as member_count,
               count(distinct grade) filter (where grade is not null) as grade_kinds,
               min(grade) filter (where grade is not null) as one_grade,
               count(distinct bms) filter (where bms is not null) as bms_kinds,
               min(bms) filter (where bms is not null) as one_bms,
               count(*) filter (where bms is null) as bms_missing,
               count(distinct breed) filter (where breed is not null) as breed_kinds,
               min(breed) filter (where breed is not null) as one_breed,
               min(slaughter) as slaughter_from,
               max(slaughter) as slaughter_to
        from m
    ),
    mix as (
        select jsonb_object_agg(grade, n order by grade) as grade_mix
        from (select grade, count(*) as n from m where grade is not null group by grade) t
    )
    select jsonb_strip_nulls(jsonb_build_object(
        'member_count',   g.member_count,
        'grade',          case when g.grade_kinds = 1 then g.one_grade when g.grade_kinds > 1 then '혼합' end,
        'grade_mix',      mix.grade_mix,
        -- BMS는 1++ 개체에만 온다 — 전원 1++이고 BMS가 하나로 같을 때만 값, 아니면 모름.
        'bms',            case when g.grade_kinds = 1 and g.bms_kinds = 1 and g.bms_missing = 0 then g.one_bms end,
        'breed',          case when g.breed_kinds = 1 then g.one_breed end,
        'slaughter_from', g.slaughter_from,
        'slaughter_to',   g.slaughter_to
    ))
    from g, mix;
$$;

revoke all on function public.lot_members(jsonb) from public;
revoke all on function public.lot_summary(jsonb) from public;
grant execute on function public.lot_members(jsonb) to authenticated, service_role;
grant execute on function public.lot_summary(jsonb) to authenticated, service_role;

-- ───────────────────────── 2) master_livestock 구성 요약 ─────────────────────────

alter table public.master_livestock
    add column if not exists members        jsonb,
    add column if not exists member_count   integer,
    add column if not exists grade_mix      jsonb,
    add column if not exists slaughter_from date,
    add column if not exists slaughter_to   date;

comment on column public.master_livestock.members is '로트 구성 개체 요약(lot_members). 개체번호 행은 null';
comment on column public.master_livestock.grade_mix is '로트 등급 구성표 {"1++":5,"1+":2,"1":15}. 꼬리표 등급이 혼합일 때의 근거';

-- 적재할 때 구성 요약도 같이 계산한다(시그니처 그대로 — GRANT는 service_role 전용 유지).
create or replace function public.upsert_master_livestock(
    p_trace_no text, p_trace_kind text, p_source text, p_raw_payload jsonb,
    p_species text default null, p_species_group text default null, p_part_name text default null,
    p_grade text default null, p_slaughter_date date default null, p_butchery_place text default null,
    p_farm_name text default null, p_origin_country text default null, p_importer_name text default null,
    p_packing_date date default null, p_sex text default null, p_bms text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_members jsonb;
    v_summary jsonb;
begin
    if p_trace_kind = 'group' then
        v_members := public.lot_members(p_raw_payload);
        v_summary := public.lot_summary(v_members);
    end if;

    insert into public.master_livestock as m (
        trace_no, trace_kind, source, raw_payload, species, species_group,
        part_name, grade, slaughter_date, butchery_place, farm_name,
        origin_country, importer_name, packing_date, sex, bms, fetched_at,
        members, member_count, grade_mix, slaughter_from, slaughter_to
    ) values (
        upper(trim(p_trace_no)), p_trace_kind, p_source, coalesce(p_raw_payload, '{}'::jsonb),
        p_species, p_species_group, p_part_name, p_grade, p_slaughter_date,
        p_butchery_place, p_farm_name, p_origin_country, p_importer_name,
        p_packing_date, p_sex, p_bms, now(),
        v_members, (v_summary ->> 'member_count')::integer, v_summary -> 'grade_mix',
        coalesce((v_summary ->> 'slaughter_from')::date, p_slaughter_date),
        coalesce((v_summary ->> 'slaughter_to')::date, p_slaughter_date)
    )
    on conflict (trace_no) do update set
        trace_kind     = excluded.trace_kind,
        source         = excluded.source,
        raw_payload    = excluded.raw_payload,
        species        = coalesce(excluded.species, m.species),
        species_group  = coalesce(excluded.species_group, m.species_group),
        part_name      = coalesce(excluded.part_name, m.part_name),
        grade          = coalesce(excluded.grade, m.grade),
        slaughter_date = coalesce(excluded.slaughter_date, m.slaughter_date),
        butchery_place = coalesce(excluded.butchery_place, m.butchery_place),
        farm_name      = coalesce(excluded.farm_name, m.farm_name),
        origin_country = coalesce(excluded.origin_country, m.origin_country),
        importer_name  = coalesce(excluded.importer_name, m.importer_name),
        packing_date   = coalesce(excluded.packing_date, m.packing_date),
        sex            = coalesce(excluded.sex, m.sex),
        bms            = coalesce(excluded.bms, m.bms),
        fetched_at     = now(),
        members        = excluded.members,
        member_count   = excluded.member_count,
        grade_mix      = excluded.grade_mix,
        slaughter_from = coalesce(excluded.slaughter_from, m.slaughter_from),
        slaughter_to   = coalesce(excluded.slaughter_to, m.slaughter_to);
end;
$$;

-- 이미 캐시된 로트는 원문에서 다시 계산한다(재조회 없이).
update public.master_livestock m
   set members        = x.members,
       member_count   = (x.summary ->> 'member_count')::integer,
       grade_mix      = x.summary -> 'grade_mix',
       slaughter_from = coalesce((x.summary ->> 'slaughter_from')::date, m.slaughter_date),
       slaughter_to   = coalesce((x.summary ->> 'slaughter_to')::date, m.slaughter_date)
  from (
        select trace_no, public.lot_members(raw_payload) as members,
               public.lot_summary(public.lot_members(raw_payload)) as summary
          from public.master_livestock
         where trace_kind = 'group'
       ) x
 where x.trace_no = m.trace_no;

update public.master_livestock
   set slaughter_from = slaughter_date, slaughter_to = slaughter_date
 where trace_kind <> 'group' and slaughter_from is null;

-- ───────────────────────── 3) inbound_scans 꼬리표 ─────────────────────────

alter table public.inbound_scans
    add column if not exists tag_species       text,
    add column if not exists tag_part          text,
    add column if not exists tag_origin        text,
    add column if not exists tag_grade         text,
    add column if not exists tag_grade_mix     jsonb,
    add column if not exists tag_sex           text,
    add column if not exists tag_bms           text,
    add column if not exists tag_breed         text,
    add column if not exists tag_storage_state text,
    add column if not exists slaughter_from    date,
    add column if not exists slaughter_to      date,
    add column if not exists parent_scan_id    uuid references public.inbound_scans(id) on delete set null,
    add column if not exists tag_source        jsonb;

alter table public.inbound_scans drop constraint if exists inbound_scans_tag_storage_state_check;
alter table public.inbound_scans
    add constraint inbound_scans_tag_storage_state_check
    check (tag_storage_state is null or tag_storage_state in ('냉장', '냉동'));

comment on column public.inbound_scans.tag_grade is '등급. 로트 구성 등급이 섞이면 ''혼합''(근거는 tag_grade_mix)';
comment on column public.inbound_scans.tag_source is '꼬리표별 출처 {"grade":"lookup","part":"product",...} — "왜 이렇게 됐나" 설명용';
comment on column public.inbound_scans.parent_scan_id is '쪼개기(가공)로 생긴 박스의 부모 박스(2단계에서 사용)';

create index if not exists idx_inbound_scans_tags
    on public.inbound_scans (wholesaler_id, tag_species, tag_part, tag_grade)
    where status = 'NORMAL';

-- 꼬리표 계산: 이력조회 값(master_livestock)이 진실, 조회가 못 주는 것(부위·냉장/냉동)과 조회 자체가 없을 때만 상품에서.
-- 로트는 구성 요약(같으면 값·다르면 혼합)을 쓰고 master.grade/sex/bms(대표값)는 쓰지 않는다.
create or replace function public.compute_inbound_scan_tags(p_trace_no text, p_product_id uuid)
returns table(
    tag_species text, tag_part text, tag_origin text, tag_grade text, tag_grade_mix jsonb,
    tag_sex text, tag_bms text, tag_breed text, tag_storage_state text,
    slaughter_from date, slaughter_to date, tag_source jsonb
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
    m public.master_livestock%rowtype;
    p public.products%rowtype;
    s jsonb;
    src jsonb := '{}'::jsonb;
    v_is_group boolean;
begin
    select * into m from public.master_livestock where trace_no = upper(trim(coalesce(p_trace_no, '')));
    if p_product_id is not null then
        select * into p from public.products where id = p_product_id;
    end if;

    v_is_group := m.trace_no is not null and m.trace_kind = 'group';
    s := case when v_is_group then public.lot_summary(coalesce(m.members, public.lot_members(m.raw_payload))) else '{}'::jsonb end;

    -- 축종
    tag_species := coalesce(m.species_group, p.category);
    src := src || jsonb_build_object('species', case when m.species_group is not null then 'lookup' when p.category is not null then 'product' end);

    -- 부위: 조회가 주면 그것(국내산은 거의 없음), 아니면 상품(사람·발주서·GTIN이 정한 값)
    tag_part := coalesce(nullif(btrim(coalesce(m.part_name, '')), ''), p.subcategory);
    src := src || jsonb_build_object('part', case when nullif(btrim(coalesce(m.part_name, '')), '') is not null then 'lookup' when p.subcategory is not null then 'product' end);

    -- 원산지: 조회(수입/국내) 우선, 조회가 없으면 상품
    tag_origin := case when m.trace_no is not null then public.trace_origin(m.trace_kind, m.origin_country) else p.origin end;
    src := src || jsonb_build_object('origin', case when m.trace_no is not null then 'lookup' when p.origin is not null then 'product' end);

    -- 등급·BMS·성별·품종: 조회가 진실. 로트는 요약(혼합), 개체는 그대로. 조회가 없으면 상품에서 이어받는다(출처 표시).
    if m.trace_no is not null then
        tag_grade     := case when v_is_group then s ->> 'grade' else nullif(btrim(coalesce(m.grade, '')), '') end;
        tag_grade_mix := case when v_is_group then s -> 'grade_mix' end;
        tag_bms       := case when v_is_group then s ->> 'bms'
                              when nullif(btrim(coalesce(m.grade, '')), '') = '1++' then nullif(btrim(coalesce(m.bms, '')), '') end;
        tag_sex       := case when v_is_group then null else nullif(btrim(coalesce(m.sex, '')), '') end;
        tag_breed     := case when v_is_group then s ->> 'breed' else public.trace_breed(m.species) end;
        src := src || jsonb_build_object('grade', 'lookup', 'bms', 'lookup', 'sex', 'lookup', 'breed', 'lookup');
    else
        tag_grade := p.grade; tag_bms := p.bms; tag_sex := p.sex; tag_breed := p.breed;
        src := src || jsonb_build_object('grade', 'product', 'bms', 'product', 'sex', 'product', 'breed', 'product');
    end if;

    -- 냉장/냉동: 조회에 없다. 상품(사람·발주서·라벨)에서만.
    tag_storage_state := case when p.storage_state in ('냉장', '냉동') then p.storage_state end;
    src := src || jsonb_build_object('storage', case when tag_storage_state is not null then 'product' end);

    slaughter_from := coalesce(m.slaughter_from, (s ->> 'slaughter_from')::date, m.slaughter_date);
    slaughter_to   := coalesce(m.slaughter_to,   (s ->> 'slaughter_to')::date,   m.slaughter_date);

    tag_source := jsonb_strip_nulls(src);
    return next;
end;
$$;

revoke all on function public.compute_inbound_scan_tags(text, uuid) from public;
grant execute on function public.compute_inbound_scan_tags(text, uuid) to authenticated, service_role;

-- 박스가 생기거나 번호·상품이 바뀌면 꼬리표를 다시 계산한다(2단계에서 꼬리표가 입력값이 되기 전까지의 과도기 규칙).
create or replace function public.trg_fill_inbound_scan_tags()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    t record;
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

    return new;
end;
$$;

drop trigger if exists trg_inbound_scans_fill_tags on public.inbound_scans;
create trigger trg_inbound_scans_fill_tags
    before insert or update of trace_no, product_id on public.inbound_scans
    for each row execute function public.trg_fill_inbound_scan_tags();

-- 이력조회가 나중에 들어와도(재시도·캐시 갱신) 그 번호의 박스 꼬리표를 따라잡는다.
create or replace function public.trg_master_livestock_refresh_tags()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    update public.inbound_scans s
       set tag_species = x.tag_species, tag_part = x.tag_part, tag_origin = x.tag_origin,
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

drop trigger if exists trg_master_livestock_refresh_tags on public.master_livestock;
create trigger trg_master_livestock_refresh_tags
    after insert or update of raw_payload, grade, sex, bms, species, part_name, origin_country, members on public.master_livestock
    for each row execute function public.trg_master_livestock_refresh_tags();

-- 기존 박스 백필(재고 집계에는 아직 안 쓰므로 동작 변화 없음). UPDATE … FROM은 대상 행을 함수 인자로 못 넘기므로 LATERAL로 돈다.
update public.inbound_scans s
   set tag_species = x.tag_species, tag_part = x.tag_part, tag_origin = x.tag_origin,
       tag_grade = x.tag_grade, tag_grade_mix = x.tag_grade_mix, tag_sex = x.tag_sex,
       tag_bms = x.tag_bms, tag_breed = x.tag_breed, tag_storage_state = x.tag_storage_state,
       slaughter_from = x.slaughter_from, slaughter_to = x.slaughter_to, tag_source = x.tag_source
  from (
        select b.id, t.*
          from public.inbound_scans b
         cross join lateral public.compute_inbound_scan_tags(b.trace_no, b.product_id) t
         where b.tag_source is null
       ) x
 where x.id = s.id;

-- ───────────────────────── 4) 전환 미리보기 ─────────────────────────
-- 2단계에서 재고가 바뀌는 박스: 꼬리표 등급이 '혼합'인데 지금 꽂힌 상품은 특정 등급인 것(지금은 그 등급 재고로 잘못 세고 있음).
create or replace function public.preview_mixed_lot_boxes(p_wholesaler_id uuid)
returns table(scan_id uuid, trace_no text, product_name text, product_grade text, grade_mix jsonb, remaining_weight numeric, created_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select s.id, s.trace_no, p.name, p.grade, s.tag_grade_mix, s.remaining_weight, s.created_at
      from public.inbound_scans s
      join public.products p on p.id = s.product_id
     where s.wholesaler_id = p_wholesaler_id
       and s.status = 'NORMAL'
       and s.tag_grade = '혼합'
       and nullif(btrim(coalesce(p.grade, '')), '') is not null
       and public.can_access_wholesaler(p_wholesaler_id)
     order by s.created_at desc;
$$;

revoke all on function public.preview_mixed_lot_boxes(uuid) from public;
grant execute on function public.preview_mixed_lot_boxes(uuid) to authenticated, service_role;
