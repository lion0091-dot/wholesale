-- ====================================================================
-- 소 상품 정체성에 "성별"(거세/암) 추가 + "BMS"(마블링 세부점수, 1++ 한정) 도입
-- (사장님 결정, 2026-09-30)
--
-- 배경: 국립축산과학원 이력조회(animalTrace) 실제 응답을 확인한 결과
-- (사장님이 확장팩 세션에서 실조회, wholesale-cf 세션으로 결과 전달받음):
--   - sexNm: 개체번호 응답에 "거세"/"암" 두 값이 실제로 나온다(7건 중 6건 거세, 1건 암).
--     "거세우"/"암소"/"수소" 같은 형태는 응답에 없다 — 원문 그대로 저장한다.
--   - insfat: 1++ 등급 개체에서만 응답에 실린다(그 외 등급은 필드 자체가 없음).
--     값은 접두어 없는 숫자 문자열 그대로("7", "8", "9") — "No.7" 같은 표기는 API에 없다.
--
-- 성별은 품종·등급과 같은 성격이다(사장님 "필수" 지시) — 국내산 소에서만 의미가
-- 있고(수입육은 이 API 자체를 안 쓴다), 다르면 다른 상품·다른 재고 단위다.
-- BMS는 그와 달리 등급이 1++일 때만 켜지는 "조건부 키"다(bmsAppliesTo, 사장님:
-- "bms도 별도 상품이어야지 원가가 다르다") — 같은 1++라도 BMS(7/8/9)가 다르면
-- 실제 매입원가가 달라 별도 재고여야 한다.
--
-- TS 쪽 규칙은 lib/products/identity-key.ts — 바꾸면 양쪽을 같이 고칠 것.
-- 함수 본문은 로컬 DB의 pg_get_functiondef(152 적용 후) 기준으로 패치했다(079 방식).
-- ====================================================================

-- --------------------------------------------------------------------
-- 1) master_livestock — 이력조회 캐시에 성별·BMS 원문 저장
-- --------------------------------------------------------------------
ALTER TABLE public.master_livestock
    ADD COLUMN IF NOT EXISTS sex TEXT,
    ADD COLUMN IF NOT EXISTS bms TEXT;

CREATE OR REPLACE FUNCTION public.upsert_master_livestock(
    p_trace_no       TEXT,
    p_trace_kind     TEXT,
    p_source         TEXT,
    p_raw_payload    JSONB,
    p_species        TEXT DEFAULT NULL,
    p_species_group  TEXT DEFAULT NULL,
    p_part_name      TEXT DEFAULT NULL,
    p_grade          TEXT DEFAULT NULL,
    p_slaughter_date DATE DEFAULT NULL,
    p_butchery_place TEXT DEFAULT NULL,
    p_farm_name      TEXT DEFAULT NULL,
    p_origin_country TEXT DEFAULT NULL,
    p_importer_name  TEXT DEFAULT NULL,
    p_packing_date   DATE DEFAULT NULL,
    p_sex            TEXT DEFAULT NULL,
    p_bms            TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 호출 권한은 GRANT(service_role 전용)가 결정한다 — 위 주석 참고.
    INSERT INTO public.master_livestock AS m (
        trace_no, trace_kind, source, raw_payload, species, species_group,
        part_name, grade, slaughter_date, butchery_place, farm_name,
        origin_country, importer_name, packing_date, sex, bms, fetched_at
    ) VALUES (
        upper(trim(p_trace_no)), p_trace_kind, p_source, COALESCE(p_raw_payload, '{}'::jsonb),
        p_species, p_species_group, p_part_name, p_grade, p_slaughter_date,
        p_butchery_place, p_farm_name, p_origin_country, p_importer_name,
        p_packing_date, p_sex, p_bms, now()
    )
    ON CONFLICT (trace_no) DO UPDATE SET
        trace_kind     = EXCLUDED.trace_kind,
        source         = EXCLUDED.source,
        raw_payload    = EXCLUDED.raw_payload,
        species        = COALESCE(EXCLUDED.species, m.species),
        species_group  = COALESCE(EXCLUDED.species_group, m.species_group),
        part_name      = COALESCE(EXCLUDED.part_name, m.part_name),
        grade          = COALESCE(EXCLUDED.grade, m.grade),
        slaughter_date = COALESCE(EXCLUDED.slaughter_date, m.slaughter_date),
        butchery_place = COALESCE(EXCLUDED.butchery_place, m.butchery_place),
        farm_name      = COALESCE(EXCLUDED.farm_name, m.farm_name),
        origin_country = COALESCE(EXCLUDED.origin_country, m.origin_country),
        importer_name  = COALESCE(EXCLUDED.importer_name, m.importer_name),
        packing_date   = COALESCE(EXCLUDED.packing_date, m.packing_date),
        sex            = COALESCE(EXCLUDED.sex, m.sex),
        bms            = COALESCE(EXCLUDED.bms, m.bms),
        fetched_at     = now();
END;
$$;

-- 098이 만든 옛 시그니처(파라미터 14개)는 더 이상 안 쓴다 — 새 시그니처(16개)만 남긴다.
DROP FUNCTION IF EXISTS public.upsert_master_livestock(
    TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, DATE
);

REVOKE EXECUTE ON FUNCTION public.upsert_master_livestock(
    TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_master_livestock(
    TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT
) TO service_role;

-- --------------------------------------------------------------------
-- 2) products — 성별(필수 키)·BMS(1++ 한정 조건부 키) 컬럼 + 정체성 유니크 인덱스
-- --------------------------------------------------------------------
-- 냉장/냉동(storage_state)은 계란을 제외한 전 축종의 정체성 일부다(사장님 결정, 2026-09-30).
-- 공공 이력조회 API에는 없는 값이라(공급처가 직접 표기) autocreate_product_for_scan은
-- 이 칸을 절대 못 채우고 항상 비워 둔다 — 부위 미지정과 같은 패턴.
ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS sex TEXT,
    ADD COLUMN IF NOT EXISTS bms TEXT,
    ADD COLUMN IF NOT EXISTS storage_state TEXT,
    ADD CONSTRAINT products_sex_valid CHECK (sex IS NULL OR (category = '소' AND sex IN ('거세', '암'))),
    ADD CONSTRAINT products_bms_valid CHECK (bms IS NULL OR (category = '소' AND grade = '1++' AND bms IN ('7', '8', '9'))),
    ADD CONSTRAINT products_storage_state_valid CHECK (
        storage_state IS NULL OR (category IN ('소', '돼지', '닭', '오리') AND storage_state IN ('냉장', '냉동'))
    );

DROP INDEX IF EXISTS public.idx_products_cattle_identity;
CREATE UNIQUE INDEX idx_products_cattle_identity
    ON public.products (
        wholesaler_id, COALESCE(breed, ''), COALESCE(subcategory, ''), COALESCE(grade, ''),
        COALESCE(sex, ''), COALESCE(origin, ''), COALESCE(bms, ''), COALESCE(storage_state, '')
    )
    WHERE category = '소';

DROP INDEX IF EXISTS public.idx_products_pork_identity;
CREATE UNIQUE INDEX idx_products_pork_identity
    ON public.products (wholesaler_id, COALESCE(subcategory, ''), COALESCE(origin, ''), COALESCE(storage_state, ''))
    WHERE category = '돼지';

-- 계란은 storage_state가 항상 NULL(위 CHECK)이라 COALESCE(...,'')가 전부 ''로 같아서
-- 닭·오리·계란을 한 인덱스에 같이 둬도 계란의 기존 유니크 판정(축종+원산지)이 그대로 유지된다.
DROP INDEX IF EXISTS public.idx_products_poultry_egg_identity;
CREATE UNIQUE INDEX idx_products_poultry_egg_identity
    ON public.products (wholesaler_id, category, COALESCE(origin, ''), COALESCE(storage_state, ''))
    WHERE category IN ('닭', '오리', '계란');

-- --------------------------------------------------------------------
-- 3) autocreate_product_for_scan — 이력조회가 준 성별·BMS까지 정체성에 반영.
--    BMS는 이력조회가 주면(1++ 개체) 그대로 채우고, 없으면(1++가 아니거나 응답에
--    없으면) 비워 사람이 나중에 채우게 한다. 성별은 품종과 같은 성격이라, 소인데
--    성별을 모르면(BREED_UNKNOWN과 같은 이유로) 자동 생성을 하지 않는다 —
--    성별이 다른 소를 한 상품에 잘못 섞는 것보다 사무실이 직접 지정하게 둔다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.autocreate_product_for_scan(p_scan_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_master        public.master_livestock%ROWTYPE;
    v_product_id    UUID;
    v_part_name     TEXT;
    v_grade         TEXT;
    v_is_cattle     BOOLEAN;
    v_breed         TEXT;
    v_sex           TEXT;
    v_bms           TEXT;
    v_uses_part     BOOLEAN;
    v_uses_grade    BOOLEAN;
    v_uses_origin   BOOLEAN;
    v_name          TEXT;
    v_origin        TEXT;
    v_created       BOOLEAN := false;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status <> 'PENDING_MAPPING' THEN
        RAISE EXCEPTION 'SCAN_ALREADY_RESOLVED';
    END IF;

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_scan.trace_no;

    -- 축종조차 모르면 만들 수 없다. 이름도 분류도 세울 수 없기 때문이다.
    IF v_master.species_group IS NULL THEN
        RETURN jsonb_build_object('created', false, 'reason', 'INSUFFICIENT_TRACE_INFO');
    END IF;

    -- 상품 정체성 키(사장님 2026-09-27~09-30, lib/products/identity-key.ts와 같은 규칙):
    --   소 = 품종+부위+등급+성별+원산지(+1++면 BMS), 돼지 = 부위+원산지, 닭·오리·계란 = 원산지. 그 밖의 축종은 예전 방식(부위+등급).
    v_is_cattle   := v_master.species_group = '소';

    -- 소는 품종(한우/육우/젖소)도 정체성 키다. 이력조회가 준 축종 원문(species)에서 얻고, 못 얻으면 만들지 않는다 —
    -- 한우와 육우를 잘못 한 상품에 섞는 것보다 사무실이 상품을 직접 지정하게 두는 편이 낫다(PENDING_MAPPING으로 남는다).
    v_breed := CASE WHEN v_is_cattle THEN public.trace_breed(v_master.species) END;

    IF v_is_cattle AND v_breed IS NULL THEN
        RETURN jsonb_build_object('created', false, 'reason', 'BREED_UNKNOWN');
    END IF;

    -- 성별은 품종과 달리 자동 생성을 막지 않는다(2026-09-30) — 품종(한우/육우) 오분류는
    -- 표시·법적 문제로 이어지지만, 성별은 원가 구분용이라 모르면 부위 미지정과 같은
    -- 패턴으로 비워 두고 사람이 나중에 채운다(개체번호 조회는 대부분 성별을 주지만,
    -- 묶음번호 등 일부 응답엔 없을 수 있다).
    v_sex := CASE WHEN v_is_cattle THEN NULLIF(btrim(COALESCE(v_master.sex, '')), '') END;

    v_uses_part   := v_master.species_group NOT IN ('닭', '오리', '계란');
    v_uses_grade  := v_master.species_group NOT IN ('돼지', '닭', '오리', '계란');
    v_uses_origin := v_master.species_group IN ('소', '돼지', '닭', '오리', '계란');

    -- 부위·등급은 이력조회 값만 쓴다. 못 채우면 비워서 "(부위 미지정)"으로 남긴다.
    v_part_name := NULLIF(btrim(COALESCE(v_master.part_name, '')), '');
    v_grade := NULLIF(btrim(COALESCE(v_master.grade, '')), '');

    -- BMS는 1++ 개체에서만 이력조회가 준다 — 없으면(1++가 아니거나 응답에 값이
    -- 없으면) 비워서 사람이 나중에 채우게 한다(부위 미지정과 같은 패턴).
    v_bms := CASE WHEN v_is_cattle AND v_grade = '1++' THEN NULLIF(btrim(COALESCE(v_master.bms, '')), '') END;

    v_origin := public.trace_origin(v_master.trace_kind, v_master.origin_country);

    -- 부위가 NULL인 상품끼리도 재사용되도록 COALESCE로 비교한다.
    -- 보관된 상품도 대상에 넣는다 — 같은 조합을 다시 찍었으면 보관을 푸는 게 맞다.
    -- storage_state(냉장/냉동)는 공공 API에 없어 autocreate가 절대 못 채운다 — 이미
    -- 사람이 냉장/냉동을 지정해둔 상품과 잘못 합쳐지지 않도록 "미지정" 상품만 찾는다.
    SELECT id INTO v_product_id
    FROM public.products
    WHERE wholesaler_id = v_wholesaler_id
      AND category = v_master.species_group
      AND (NOT v_uses_part OR COALESCE(subcategory, '') = COALESCE(v_part_name, ''))
      AND (NOT v_uses_grade OR COALESCE(grade, '') = COALESCE(v_grade, ''))
      AND (NOT v_is_cattle OR breed = v_breed)
      AND (NOT v_is_cattle OR COALESCE(sex, '') = COALESCE(v_sex, ''))
      AND (NOT v_is_cattle OR COALESCE(bms, '') = COALESCE(v_bms, ''))
      AND storage_state IS NULL
      AND (NOT v_uses_origin OR public.origin_matches(origin, v_origin))
    ORDER BY archived_at NULLS FIRST
    LIMIT 1;

    IF v_product_id IS NULL THEN
        IF v_is_cattle THEN
            v_name := btrim(concat_ws(' ', v_breed, v_part_name, v_grade, v_sex) || CASE WHEN v_bms IS NOT NULL THEN ' (' || v_bms || ')' ELSE '' END);
        ELSIF v_master.species_group = '돼지' THEN
            v_name := COALESCE(v_part_name, '');
        ELSIF v_master.species_group IN ('닭', '오리', '계란') THEN
            v_name := v_master.species_group;
        ELSE
            v_name := btrim(
                COALESCE(NULLIF(v_master.species, ''), v_master.species_group)
                || COALESCE(' ' || v_part_name, '')
                || COALESCE(' ' || NULLIF(v_master.grade, ''), '')
            );
        END IF;

        -- 부위를 끝내 못 찾았을 때만 이름에 드러낸다.
        IF v_uses_part AND v_part_name IS NULL THEN
            v_name := btrim(v_name || ' (부위 미지정)');
        END IF;

        BEGIN
        INSERT INTO public.products (
            wholesaler_id, name, category, subcategory, origin, grade, breed, sex, bms,
            base_price, unit, stock_quantity, is_active, description, created_by
        ) VALUES (
            v_wholesaler_id, v_name, v_master.species_group,
            -- 정체성 키에 없는 칸은 처음 본 박스의 값이 상품 전체 값처럼 남지 않게 비워 둔다.
            CASE WHEN v_uses_part THEN v_part_name END,
            v_origin,
            CASE WHEN v_uses_grade THEN v_grade END,
            v_breed, v_sex, v_bms,
            0, COALESCE(NULLIF(v_scan.unit, ''), 'kg'), 0,
            -- 판매중지로 만든다 (설계 결정 4번). 가격만 넣으면 바로 팔리는 상황을 막는다.
            false,
            '입고 스캔으로 자동 등록됨 (이력번호 ' || v_scan.trace_no || ')'
            || CASE
                   WHEN v_uses_part AND v_part_name IS NULL
                       THEN ' — 이력조회·명세서 어디에도 부위가 없어 비워두었습니다. 채워주세요.'
                   ELSE ''
               END,
            auth.uid()
        )
        RETURNING id INTO v_product_id;

        v_created := true;
        EXCEPTION WHEN unique_violation THEN
            -- 같은 정체성의 상품을 동시에 만들려던 다른 요청이 먼저 만들었다 — 그 상품을 쓴다.
            SELECT id INTO v_product_id
            FROM public.products
            WHERE wholesaler_id = v_wholesaler_id
              AND category = v_master.species_group
              AND (NOT v_uses_part OR COALESCE(subcategory, '') = COALESCE(v_part_name, ''))
              AND (NOT v_uses_grade OR COALESCE(grade, '') = COALESCE(v_grade, ''))
              AND (NOT v_is_cattle OR breed = v_breed)
              AND (NOT v_is_cattle OR COALESCE(sex, '') = COALESCE(v_sex, ''))
              AND (NOT v_is_cattle OR COALESCE(bms, '') = COALESCE(v_bms, ''))
              AND storage_state IS NULL
              AND (NOT v_uses_origin OR public.origin_matches(origin, v_origin))
            LIMIT 1;
        END;

    ELSE
        UPDATE public.products
        SET archived_at = NULL, updated_at = now()
        WHERE id = v_product_id AND archived_at IS NOT NULL;
    END IF;

    PERFORM public.resolve_inbound_mapping(p_scan_id, v_product_id, true);

    -- 바코드에 상품코드가 있었다면 그것도 함께 학습한다. 부위가 안 와도
    -- 이 코드로는 다음부터 정확히 같은 상품에 붙는다.
    PERFORM public.learn_gtin_product(p_scan_id, v_product_id);

    RETURN jsonb_build_object(
        'created', v_created,
        'product_id', v_product_id,
        'product_name', (SELECT name FROM public.products WHERE id = v_product_id),
        'part_missing', v_uses_part AND v_part_name IS NULL,
        'needs_price', (SELECT base_price = 0 FROM public.products WHERE id = v_product_id),
        'needs_activation', (SELECT NOT is_active FROM public.products WHERE id = v_product_id)
    );
END;
$function$;

-- --------------------------------------------------------------------
-- 4) trace_product_map — 학습된 스캔→상품 매핑에도 성별을 넣는다. 품종(breed)이
--    140에서 그랬듯, 성별이 유니크 키에 없으면 같은 부위·등급·품종에 성별만
--    다른 두 상품이 학습 시 서로의 매핑 행을 덮어쓴다(예: "거세 등심 1++"을
--    배웠다가 "암 등심 1++"을 배우면 같은 행이 됨 — 둘 다 (소, 등심, 1++)까지는
--    똑같아서). 원산지·BMS는 품종과 같은 방식으로 products 테이블 조인 검사로
--    거른다(별도 컬럼 안 만듦, breed가 이미 그렇게 처리되고 있었다).
-- --------------------------------------------------------------------
ALTER TABLE public.trace_product_map
    ADD COLUMN IF NOT EXISTS sex TEXT;

DROP INDEX IF EXISTS public.idx_trace_product_map_unique;
CREATE UNIQUE INDEX idx_trace_product_map_unique
    ON public.trace_product_map (wholesaler_id, species_group, part_name, COALESCE(grade, ''), COALESCE(breed, ''), COALESCE(sex, ''));

CREATE OR REPLACE FUNCTION public.record_inbound_scan_base(p_trace_no text, p_weight numeric, p_scan_type text, p_product_id uuid DEFAULT NULL::uuid, p_fail_reason text DEFAULT NULL::text, p_import_row_id uuid DEFAULT NULL::uuid, p_memo text DEFAULT NULL::text, p_confirm_duplicate boolean DEFAULT false, p_fail_detail text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_trace_no      TEXT;
    v_master        public.master_livestock%ROWTYPE;
    v_product_id    UUID;
    v_status        TEXT;
    v_scan_id       UUID;
    v_reason        TEXT;
    v_dup_at        TIMESTAMPTZ;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    IF p_weight IS NULL OR p_weight <= 0 THEN
        RAISE EXCEPTION 'INVALID_WEIGHT';
    END IF;

    v_trace_no := upper(trim(COALESCE(p_trace_no, '')));
    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    -- 같은 업체가 같은 번호를 동시에 두 번 보내면(스캐너 이중 발사·더블 탭) 둘 다 아래 중복 검사를 통과해 박스가 둘 생긴다.
    -- 업체+번호별로 줄을 세워 두 번째 요청이 첫 요청의 커밋을 본 뒤에 검사하게 한다(트랜잭션이 끝나면 자동 해제).
    PERFORM pg_advisory_xact_lock(hashtextextended(v_wholesaler_id::text || ':' || v_trace_no, 0));

    IF NOT p_confirm_duplicate AND p_scan_type <> 'EXCEL' THEN
        SELECT created_at INTO v_dup_at
        FROM public.inbound_scans
        WHERE wholesaler_id = v_wholesaler_id
          AND trace_no = v_trace_no
          AND weight = p_weight
          AND status IN ('NORMAL', 'EXCEPTION', 'PENDING_MAPPING')
          AND created_at > now() - public.duplicate_scan_window()
        ORDER BY created_at DESC
        LIMIT 1;

        IF v_dup_at IS NOT NULL THEN
            RAISE EXCEPTION 'DUPLICATE_SUSPECTED:%', to_char(v_dup_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI');
        END IF;
    END IF;

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_trace_no;

    IF p_product_id IS NOT NULL THEN
        SELECT id INTO v_product_id
        FROM public.products
        WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;

        IF v_product_id IS NULL THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
        END IF;

    ELSIF v_master.trace_no IS NOT NULL AND v_master.part_name IS NOT NULL THEN
        -- 소는 원산지·성별도 정체성 키라(lib/products/identity-key.ts) 학습된 매핑이 다른 원산지·성별의 상품으로 새지 않게 거른다.
        SELECT m.product_id INTO v_product_id
        FROM public.trace_product_map m
        JOIN public.products p ON p.id = m.product_id
        WHERE m.wholesaler_id = v_wholesaler_id
          AND m.species_group = v_master.species_group
          AND m.part_name = v_master.part_name
          AND (m.grade IS NULL OR m.grade = v_master.grade)
          -- 소는 품종(한우/육우/젖소)도 정체성 키라 다른 품종의 상품으로 새지 않게 거른다. 이력조회가 품종을 못 주면 매핑하지 않는다(사무실이 고른다).
          AND (v_master.species_group <> '소' OR (p.breed IS NOT NULL AND p.breed = public.trace_breed(v_master.species)))
          -- 소는 성별도 정체성 키다(2026-09-30). 품종과 달리 성별은 모를 때 매핑을 막지
          -- 않는다 — 양쪽 다 비어있는("성별 미지정" 상품 ↔ 이력조회가 성별을 안 준 경우)
          -- 매핑은 허용한다(COALESCE 비교, autocreate_product_for_scan과 같은 원칙).
          AND (v_master.species_group <> '소' OR COALESCE(p.sex, '') = COALESCE(v_master.sex, ''))
          -- 소·돼지·닭·오리·계란은 원산지가 정체성 키라(lib/products/identity-key.ts) 학습된 매핑이 다른 원산지의 상품으로 새지 않게 거른다.
          AND (
                v_master.species_group NOT IN ('소', '돼지', '닭', '오리', '계란')
                OR public.origin_matches(p.origin, public.trace_origin(v_master.trace_kind, v_master.origin_country))
          )
        ORDER BY m.grade NULLS LAST
        LIMIT 1;
    END IF;

    IF v_master.trace_no IS NULL THEN
        v_status := 'EXCEPTION';
        v_reason := COALESCE(p_fail_reason, 'NOT_FOUND');
    ELSIF v_product_id IS NULL THEN
        v_status := 'PENDING_MAPPING';
        v_reason := 'UNMAPPED_PRODUCT';
    ELSE
        v_status := 'NORMAL';
        v_reason := NULL;
    END IF;

    INSERT INTO public.inbound_scans (
        wholesaler_id, trace_no, product_id, weight, scan_type, status,
        remaining_weight, import_row_id, memo, scanned_by
    ) VALUES (
        v_wholesaler_id, v_trace_no, v_product_id, p_weight, p_scan_type, v_status,
        CASE WHEN v_status = 'NORMAL' THEN p_weight ELSE 0 END,
        p_import_row_id, p_memo, auth.uid()
    )
    RETURNING id INTO v_scan_id;

    IF v_status = 'NORMAL' THEN
        PERFORM public.ensure_opening_balance(v_product_id);

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, created_by
        ) VALUES (
            v_wholesaler_id, v_product_id, v_scan_id, p_weight,
            'INBOUND', 'inbound_scan', v_scan_id, auth.uid()
        );

        PERFORM public.recalc_product_stock(v_product_id);
    ELSE
        INSERT INTO public.livestock_exception_log (
            wholesaler_id, inbound_scan_id, raw_input, reason, detail
        ) VALUES (
            v_wholesaler_id, v_scan_id, v_trace_no, v_reason,
            CASE WHEN v_status = 'PENDING_MAPPING'
                 THEN '이력 조회는 성공했으나 상품 매핑이 확정되지 않았습니다.'
                 ELSE p_fail_detail END
        );
    END IF;

    RETURN jsonb_build_object(
        'scan_id',        v_scan_id,
        'trace_no',       v_trace_no,
        'status',         v_status,
        'product_id',     v_product_id,
        'master_found',   v_master.trace_no IS NOT NULL,
        'species_group',  v_master.species_group,
        'part_name',      v_master.part_name,
        'grade',          v_master.grade,
        'slaughter_date', v_master.slaughter_date,
        'packing_date',   v_master.packing_date
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping(p_scan_id uuid, p_product_id uuid, p_remember boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_master        public.master_livestock%ROWTYPE;
    v_product_part  TEXT;
    v_po            JSONB;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status NOT IN ('PENDING_MAPPING', 'EXCEPTION') THEN
        RAISE EXCEPTION 'SCAN_ALREADY_RESOLVED';
    END IF;

    PERFORM 1 FROM public.products
    WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    UPDATE public.inbound_scans
    SET product_id = p_product_id,
        status = 'NORMAL',
        remaining_weight = weight
    WHERE id = p_scan_id;

    PERFORM public.ensure_opening_balance(p_product_id);

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, created_by
    ) VALUES (
        v_wholesaler_id, p_product_id, p_scan_id, v_scan.weight,
        'INBOUND', 'inbound_scan', p_scan_id, auth.uid()
    );

    PERFORM public.recalc_product_stock(p_product_id);

    UPDATE public.livestock_exception_log
    SET resolved_status = 'RESOLVED',
        resolved_by = auth.uid(),
        resolved_at = now()
    WHERE inbound_scan_id = p_scan_id AND resolved_status = 'PENDING';

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_scan.trace_no;
    SELECT subcategory INTO v_product_part FROM public.products WHERE id = p_product_id;

    IF p_remember THEN
        IF v_master.part_name IS NOT NULL AND v_master.species_group IS NOT NULL THEN
            INSERT INTO public.trace_product_map (
                wholesaler_id, species_group, part_name, grade, breed, sex, product_id, created_by
            ) VALUES (
                v_wholesaler_id, v_master.species_group, v_master.part_name,
                v_master.grade, CASE WHEN v_master.species_group = '소' THEN public.trace_breed(v_master.species) END,
                CASE WHEN v_master.species_group = '소' THEN v_master.sex END,
                p_product_id, auth.uid()
            )
            ON CONFLICT (wholesaler_id, species_group, part_name, COALESCE(grade, ''), COALESCE(breed, ''), COALESCE(sex, ''))
            DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now();
        END IF;
    END IF;

    IF v_scan.supplier_id IS NOT NULL THEN
        v_po := public.judge_scan_purchase_order(p_scan_id);
    END IF;

    RETURN jsonb_build_object(
        'scan_id', p_scan_id,
        'status', CASE WHEN v_po ->> 'result' = 'REJECTED' THEN 'REJECTED' ELSE 'NORMAL' END,
        'product_id', p_product_id,
        'part_mismatch', public.parts_conflict(v_master.part_name, v_product_part),
        'trace_part', v_master.part_name,
        'product_part', v_product_part
    ) || CASE WHEN v_po IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('po', v_po) END;
END;
$function$;
