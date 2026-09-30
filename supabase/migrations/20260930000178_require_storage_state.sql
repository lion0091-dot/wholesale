-- 178: 냉장/냉동은 무조건 채워져야 하는 정보다 — 어디서도 못 정했으면 빈 상품을 만들지 않고 사람이 고르게 한다 (사장님 2026-09-30).
--
-- 순서: 상품코드(GTIN) 학습 → 전표(발주서)에 있으면 그 상품의 냉장/냉동 → 박스에 적힌 냉장/냉동(사람이 입력) → 전표가 없어도
-- 냉장/냉동이 지정된 같은 상품이 하나뿐이면 그것 → 그래도 없으면 NEEDS_STORAGE(상품 확인 필요로 보관, 화면에서 냉장/냉동 고르기).
-- 냉장/냉동이 비어 있는 옛 상품을 다시 쓰던 동작(174의 2단계)은 소·돼지·닭·오리에서는 없앤다. 양·가공육·계란은 냉장/냉동이 없는 축종이라 그대로다.
-- 또한 176이 냉장/냉동을 소·돼지·닭·오리 밖의 축종에도 넣으려다 products_storage_state_valid CHECK에 걸릴 수 있던 결함을 바로잡는다.
-- 함수 본문은 로컬 DB의 pg_get_functiondef(177 적용 후) 기준으로 패치했다(079 방식).

CREATE OR REPLACE FUNCTION public.autocreate_product_for_scan(p_scan_id uuid, p_part_hint text DEFAULT NULL::text, p_storage_hint text DEFAULT NULL::text)
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
    v_cand_count    INTEGER;
    v_cand_id       UUID;
    v_storage       TEXT;
    v_uses_storage  BOOLEAN;
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

    -- 176: GTIN이 없는 박스는 사람이 박스 라벨을 보고 부위·냉장/냉동을 한글로 입력한다.
    --      이력조회가 부위를 줬다면 그것이 우선이다. 계란은 냉장/냉동을 쓰지 않는다. 그 밖의 값은 무시한다.
    IF v_uses_part THEN
        v_part_name := COALESCE(v_part_name, NULLIF(left(btrim(COALESCE(p_part_hint, '')), 40), ''));
    END IF;

    -- 냉장/냉동은 소·돼지·닭·오리에만 있다(products_storage_state_valid CHECK). 그 밖의 축종(양·가공육·계란)은 입력값을 무시한다.
    v_uses_storage := v_master.species_group IN ('소', '돼지', '닭', '오리');
    v_storage := CASE WHEN v_uses_storage AND p_storage_hint IN ('냉장', '냉동') THEN p_storage_hint END;

    -- BMS는 1++ 개체에서만 이력조회가 준다 — 없으면(1++가 아니거나 응답에 값이
    -- 없으면) 비워서 사람이 나중에 채우게 한다(부위 미지정과 같은 패턴).
    v_bms := CASE WHEN v_is_cattle AND v_grade = '1++' THEN NULLIF(btrim(COALESCE(v_master.bms, '')), '') END;

    v_origin := public.trace_origin(v_master.trace_kind, v_master.origin_country);

    -- 상품을 찾는 순서 (174, 사장님 2026-09-30 "발주서 우선 + 냉장/냉동 지정 상품도 후보"):
    --   냉장/냉동(storage_state)은 공공 API에 없어 자동 생성이 못 채운다. 그래서 사람·발주서가 냉장/냉동을 지정해 둔 상품과
    --   스캔 상품이 서로 다른 상품으로 갈라져, 발주서에 있는 물건이 "없는 물건"으로 거절되던 문제(재현됨)를 막는다.
    --   1) 스캔에 거래처가 실렸으면, 그 거래처의 열린 발주서 줄 중 스캔이 아는 값과 맞는 상품이 정확히 하나일 때 그 상품을 쓴다
    --      (스캔이 모르는 부위·냉장/냉동은 발주서 값을 이어받는다, 175). 여럿이면 자동으로 정하지 않고 NEEDS_CHOICE.
    --   2) 냉장/냉동이 "미지정"인 상품(기존 동작).
    --   3) 냉장/냉동이 지정된 상품 중 맞는 것이 정확히 하나일 때. 냉장·냉동이 둘 다 있으면 정하지 않고 (2)처럼 새로 만든다.
    --   보관된 상품도 대상에 넣는다 — 같은 조합을 다시 찍었으면 보관을 푸는 게 맞다.
    v_product_id := NULL;

    IF v_scan.supplier_id IS NOT NULL THEN
        -- 175: 스캔 정보에 없는 칸(부위·냉장/냉동 등)은 발주서대로 왔다고 본다 — scan_po_candidates가 아는 값만 비교한다.
        --      후보가 하나면 그 상품, 여럿이면 자동으로 정하지 않고 "확인 필요"로 남겨 박스 라벨을 본 사람이 후보 중에서 고르게 한다.
        SELECT count(*), (array_agg(c.product_id))[1]
          INTO v_cand_count, v_cand_id
        FROM public.scan_po_candidates(p_scan_id, p_part_hint, v_storage) c;

        IF v_cand_count = 1 THEN
            v_product_id := v_cand_id;
        ELSIF v_cand_count >= 2 THEN
            RETURN jsonb_build_object('created', false, 'reason', 'NEEDS_CHOICE', 'candidate_count', v_cand_count);
        ELSIF EXISTS (
            SELECT 1
            FROM public.purchase_order_lines l
            JOIN public.purchase_orders po ON po.id = l.purchase_order_id
            WHERE po.wholesaler_id = v_wholesaler_id
              AND po.supplier_id = v_scan.supplier_id
              AND po.status = 'OPEN'
        ) THEN
            -- 177: 그 거래처의 열린 발주서가 있는데 맞는 상품이 하나도 없으면 상품을 새로 만들지 않고 보관(상품 확인 필요)한다.
            --      입력 오타("등신")로 엉뚱한 상품이 생기거나 거절되던 것을, 사람이 그 거래처 발주서 상품 중에서 고르게 한다(사장님 2026-09-30).
            RETURN jsonb_build_object('created', false, 'reason', 'NO_MATCH');
        END IF;
    END IF;

    IF v_product_id IS NULL THEN
        SELECT p.id INTO v_product_id
        FROM public.products p
        WHERE p.wholesaler_id = v_wholesaler_id
          AND p.category = v_master.species_group
          AND (NOT v_uses_part OR COALESCE(p.subcategory, '') = COALESCE(v_part_name, ''))
          AND (NOT v_uses_grade OR COALESCE(p.grade, '') = COALESCE(v_grade, ''))
          AND (NOT v_is_cattle OR p.breed = v_breed)
          AND (NOT v_is_cattle OR COALESCE(p.sex, '') = COALESCE(v_sex, ''))
          AND (NOT v_is_cattle OR COALESCE(p.bms, '') = COALESCE(v_bms, ''))
          AND (NOT v_uses_origin OR public.origin_matches(p.origin, v_origin))
          AND (CASE WHEN v_storage IS NOT NULL THEN p.storage_state = v_storage WHEN NOT v_uses_storage THEN p.storage_state IS NULL ELSE false END)
        ORDER BY p.archived_at NULLS FIRST
        LIMIT 1;
    END IF;

    IF v_product_id IS NULL AND v_storage IS NULL AND v_uses_storage THEN
        SELECT count(*), (array_agg(p.id))[1]
          INTO v_cand_count, v_cand_id
        FROM public.products p
        WHERE p.wholesaler_id = v_wholesaler_id
          AND p.category = v_master.species_group
          AND (NOT v_uses_part OR COALESCE(p.subcategory, '') = COALESCE(v_part_name, ''))
          AND (NOT v_uses_grade OR COALESCE(p.grade, '') = COALESCE(v_grade, ''))
          AND (NOT v_is_cattle OR p.breed = v_breed)
          AND (NOT v_is_cattle OR COALESCE(p.sex, '') = COALESCE(v_sex, ''))
          AND (NOT v_is_cattle OR COALESCE(p.bms, '') = COALESCE(v_bms, ''))
          AND (NOT v_uses_origin OR public.origin_matches(p.origin, v_origin))
          AND p.storage_state IS NOT NULL;

        IF v_cand_count = 1 THEN
            v_product_id := v_cand_id;
        END IF;
    END IF;

    -- 178: 냉장/냉동은 무조건 채워져야 하는 정보다(사장님 2026-09-30). 상품코드·발주서·박스 표기 어디서도 못 정했으면
    --      냉장/냉동이 빈 상품을 만들지 않고 "상품 확인 필요"로 두어 사람이 냉장/냉동을 고르게 한다(resolve_scan_storage).
    IF v_product_id IS NULL AND v_uses_storage AND v_storage IS NULL THEN
        RETURN jsonb_build_object('created', false, 'reason', 'NEEDS_STORAGE');
    END IF;

    IF v_product_id IS NULL THEN
        IF v_is_cattle THEN
            -- BMS는 등급 바로 뒤 괄호로 묶는다("1++(9)") — TS 쪽(identity-key.ts의
            -- composeIdentityName, product-match.ts, message.ts)과 표기를 통일한다
            -- (2026-09-30, 마이그레이션 162). 전에는 " (9)"를 문자열 끝에 붙여서
            -- "한우 안심 1++ 거세 (9)"처럼 성별 뒤에 왔었다.
            v_name := btrim(concat_ws(
                ' ', v_breed, v_part_name,
                CASE WHEN v_bms IS NOT NULL THEN v_grade || '(' || v_bms || ')' ELSE v_grade END,
                v_sex
            ));
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

        -- 냉장/냉동은 이름 맨 앞에 붙인다(lib/products/identity-key.ts의 composeIdentityName과 같은 표기).
        IF v_storage IS NOT NULL THEN
            v_name := btrim(v_storage || ' ' || v_name);
        END IF;

        -- 부위를 끝내 못 찾았을 때만 이름에 드러낸다.
        IF v_uses_part AND v_part_name IS NULL THEN
            v_name := btrim(v_name || ' (부위 미지정)');
        END IF;

        BEGIN
        INSERT INTO public.products (
            wholesaler_id, name, category, subcategory, origin, grade, breed, sex, bms, storage_state,
            base_price, unit, stock_quantity, is_active, description, created_by
        ) VALUES (
            v_wholesaler_id, v_name, v_master.species_group,
            -- 정체성 키에 없는 칸은 처음 본 박스의 값이 상품 전체 값처럼 남지 않게 비워 둔다.
            CASE WHEN v_uses_part THEN v_part_name END,
            v_origin,
            CASE WHEN v_uses_grade THEN v_grade END,
            v_breed, v_sex, v_bms, v_storage,
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
              AND (CASE WHEN v_storage IS NOT NULL THEN storage_state = v_storage WHEN NOT v_uses_storage THEN storage_state IS NULL ELSE false END)
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
