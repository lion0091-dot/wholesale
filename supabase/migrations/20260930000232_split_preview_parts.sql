-- 쪼개기 부위별 판매 기본가 미리 보기 (2026-10-04, 사장님 결정)
--
-- 현장 직원이 쪼개기 화면에서 부위를 고르는 순간 "이 부위 판매 기본가: 28,000원 / 없음 / 상품 없음"을 보여 주고,
-- 가격을 모르면 사무실에 요청(웹푸시)할 수 있게 한다. 사무실이 상품 관리에 가격을 넣으면 현장 화면이 바로 따라온다.
--
-- 부위 → 상품 찾기 규칙은 split_resolve_product(194)와 같다. 다만 이 함수는 읽기 전용이다 — 상품을 만들지도, 보관 해제하지도 않는다.
-- 규칙을 고치면 두 함수를 같이 고친다.
-- status: OK(상품 있음) / NO_PRODUCT(찾는 상품이 아직 없음 — 사무실이 상품 관리에서 먼저 만들어야 가격이 정해진다) /
--         UNSUPPORTED(소·돼지가 아니거나 냉장/냉동·품종을 몰라 자동 연결이 안 되는 박스).

CREATE OR REPLACE FUNCTION public.split_preview_parts(p_scan_id uuid, p_parts text[])
RETURNS TABLE (part text, status text, product_id uuid, product_name text, base_price numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
    v_wid        uuid;
    v_parent     public.inbound_scans%rowtype;
    v_pp         public.products%rowtype;
    v_species    text;
    v_breed      text;
    v_grade      text;
    v_sex        text;
    v_bms        text;
    v_origin     text;
    v_storage    text;
    v_is_cattle  boolean;
    v_domestic   boolean;
    v_part       text;
    v_found      public.products%rowtype;
begin
    v_wid := public.resolve_current_wholesaler_id();

    if v_wid is null then
        raise exception 'NOT_A_SUPPLIER';
    end if;

    select * into v_parent from public.inbound_scans where id = p_scan_id and wholesaler_id = v_wid;

    if v_parent.id is null then
        raise exception 'SCAN_NOT_FOUND';
    end if;

    if p_parts is null or coalesce(array_length(p_parts, 1), 0) = 0 or array_length(p_parts, 1) > 30 then
        return;
    end if;

    select * into v_pp from public.products where id = v_parent.product_id;

    v_species := coalesce(nullif(btrim(coalesce(v_parent.tag_species, '')), ''), v_pp.category);
    v_origin  := coalesce(nullif(btrim(coalesce(v_parent.tag_origin, '')), ''), v_pp.origin);
    v_storage := coalesce(v_parent.tag_storage_state, case when v_pp.storage_state in ('냉장', '냉동') then v_pp.storage_state end);
    v_is_cattle := v_species = '소';
    v_domestic := coalesce(v_origin, '국내산') = '국내산';

    if v_species is not null and v_is_cattle then
        v_breed := coalesce(nullif(btrim(coalesce(v_parent.tag_breed, '')), ''), v_pp.breed);
        v_grade := nullif(btrim(coalesce(v_parent.tag_grade, '')), '');
        if v_grade = '혼합' then
            v_grade := null;
        end if;
        v_grade := coalesce(v_grade, case when v_parent.tag_grade is null then v_pp.grade end);
        v_sex := coalesce(nullif(btrim(coalesce(v_parent.tag_sex, '')), ''), v_pp.sex);
        v_bms := case when v_grade = '1++' then coalesce(nullif(btrim(coalesce(v_parent.tag_bms, '')), ''), v_pp.bms) end;
    end if;

    for v_part in select distinct left(nullif(btrim(coalesce(x, '')), ''), 40) from unnest(p_parts) as x loop
        continue when v_part is null;

        if v_species is null or v_species not in ('소', '돼지') or v_storage is null
           or (v_is_cattle and v_breed is null and v_domestic) then
            part := v_part; status := 'UNSUPPORTED'; product_id := null; product_name := null; base_price := null;
            return next;
            continue;
        end if;

        select * into v_found
          from public.products p
         where p.wholesaler_id = v_wid
           and p.category = v_species
           and coalesce(p.subcategory, '') = v_part
           and (not v_is_cattle or coalesce(p.breed, '') = coalesce(v_breed, ''))
           and (not v_is_cattle or coalesce(p.grade, '') = coalesce(v_grade, ''))
           and (not v_is_cattle or coalesce(p.sex, '') = coalesce(v_sex, ''))
           and (not v_is_cattle or coalesce(p.bms, '') = coalesce(v_bms, ''))
           and public.origin_matches(p.origin, v_origin)
           and p.storage_state = v_storage
         order by p.archived_at nulls first
         limit 1;

        part := v_part;

        if v_found.id is null then
            status := 'NO_PRODUCT'; product_id := null; product_name := null; base_price := null;
        else
            status := 'OK'; product_id := v_found.id; product_name := v_found.name; base_price := v_found.base_price;
        end if;

        return next;
    end loop;
end;
$function$;

REVOKE ALL ON FUNCTION public.split_preview_parts(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_preview_parts(uuid, text[]) TO authenticated, service_role;
