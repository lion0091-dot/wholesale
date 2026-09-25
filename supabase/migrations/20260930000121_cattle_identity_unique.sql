-- 소 상품 정체성(축종+부위+등급+원산지) DB 유니크 제약 (사장님 결정, 2026-09-26)
--
-- 그동안은 화면·서버 검사(assertNoDuplicateIdentity)만 있어서, 동시에 같은 소 상품을 두 건 등록하면 둘 다 통과할 수 있었다.
-- 라이브에는 소 상품이 1개뿐이고 중복·세트가 0건임을 읽기 전용으로 확인하고 건다.
--
-- 세트 상품은 소 구성품의 축종·원산지를 물려받고 부위·등급이 비어 있어 키가 겹치므로 제외한다.
-- 세트 표시는 product_bundles(다른 테이블)에만 있어 인덱스 조건으로 못 쓴다 — products 스키마를 안 건드리는 잠긴 결정 때문에
-- 세트 상품의 단위가 언제나 '세트'인 점(create_product_bundle이 고정)을 표지로 쓴다. 이 표지를 바꾸면 인덱스와
-- 아래 함수의 충돌 처리를 같이 고칠 것.
-- 보관(archived) 상품도 대상이다 — 화면 검사가 같은 상품은 새로 만들지 말고 복원하게 하는 것과 같은 이유.

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_cattle_identity
    ON public.products (wholesaler_id, COALESCE(subcategory, ''), COALESCE(grade, ''), COALESCE(origin, ''))
    WHERE category = '소' AND unit <> '세트';

-- 자동 생성 함수: 동시 생성 충돌 시 소도 기존 상품을 찾아 쓰게 한다.
-- 예전 처리는 trace_key로만 찾아서 소(trace_key NULL)는 상품 없이 진행됐다. 본문은 로컬 DB pg_get_functiondef(114 적용 후) 기준 패치(079 방식).
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
    v_trace_key     TEXT;
    v_species_word  TEXT;
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

    -- 부위: 이력조회가 주면 그게 1순위(더 정형화된 값), 없으면 명세서에서
    -- 딱 하나로 좁혀지는 값을 쓴다(2026-09-24 확정 — 명세서 기반이니 부위를
    -- 모를 이유가 없다). 둘 다 없으면 예전처럼 비워서 "(부위 미지정)"으로 남긴다.
    v_part_name := NULLIF(btrim(COALESCE(v_master.part_name, '')), '');

    IF v_part_name IS NULL THEN
        v_part_name := public.lookup_document_part_name(v_wholesaler_id, v_scan.trace_no);
    END IF;

    -- 등급: 이력조회가 주면 그게 1순위. 소는 이력에 등급이 없으면 명세서 줄에서 딱 하나로 좁혀지는 값으로 채운다
    -- (2026-09-24 사장님: 기반은 명세서. 부위와 같은 방식 — 조회가 이기고 명세서는 빈칸만 메운다).
    v_grade := NULLIF(btrim(COALESCE(v_master.grade, '')), '');
    v_is_cattle := v_master.species_group = '소';

    IF v_is_cattle AND v_grade IS NULL THEN
        v_grade := public.lookup_document_grade(v_wholesaler_id, v_scan.trace_no);
    END IF;

    v_origin := public.trace_origin(v_master.trace_kind, v_master.origin_country);

    -- 소 외 축종: 이력번호에서 파싱한 출처 키(돼지 농장·닭/오리 도축장 …)가 정체성의 일부다(사장님 2026-09-24).
    -- 키를 못 뽑는 번호(형식 밖)는 예전 방식(축종+부위+등급)으로 찾는다.
    v_trace_key := CASE WHEN v_is_cattle THEN NULL ELSE public.trace_identity_key(v_scan.trace_no) END;

    -- 부위가 NULL인 상품끼리도 재사용되도록 COALESCE로 비교한다.
    -- 보관된 상품도 대상에 넣는다 — 같은 조합을 다시 찍었으면 보관을 푸는 게 맞다.
    IF v_trace_key IS NOT NULL THEN
        -- 같은 출처 + 같은 부위(이력·명세서에서 온 값)면 같은 상품. 등급·원산지는 키가 아니다.
        SELECT id INTO v_product_id
        FROM public.products
        WHERE wholesaler_id = v_wholesaler_id
          AND category = v_master.species_group
          AND trace_key = v_trace_key
          AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
        ORDER BY archived_at NULLS FIRST
        LIMIT 1;
    ELSE
        SELECT id INTO v_product_id
        FROM public.products
        WHERE wholesaler_id = v_wholesaler_id
          AND category = v_master.species_group
          AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
          AND COALESCE(grade, '') = COALESCE(v_grade, '')
          AND (NOT v_is_cattle OR origin = v_origin)
        ORDER BY archived_at NULLS FIRST
        LIMIT 1;
    END IF;

    IF v_product_id IS NULL THEN
        IF v_is_cattle THEN
            v_name := btrim(concat_ws(' ', v_part_name, v_grade));
        ELSIF v_trace_key IS NOT NULL THEN
            -- 같은 부위라도 출처가 다르면 다른 상품이라 이름에 출처를 드러낸다: "삼겹살 (농장 400770)".
            -- 닭/오리는 카테고리 태그만으로 닭인지 오리인지 안 보여서 축종 글자도 붙인다.
            v_species_word := split_part(v_trace_key, ':', 1);
            v_name := btrim(
                btrim(concat_ws(' ',
                    CASE WHEN v_master.species_group = '닭/오리' THEN v_species_word END,
                    v_part_name))
                || ' ('
                || CASE v_species_word WHEN '돼지' THEN '농장' WHEN '계란' THEN '발급' ELSE '도축장' END
                || ' ' || split_part(v_trace_key, ':', 2) || ')'
            );
        ELSE
            v_name := btrim(
                COALESCE(NULLIF(v_master.species, ''), v_master.species_group)
                || COALESCE(' ' || v_part_name, '')
                || COALESCE(' ' || NULLIF(v_master.grade, ''), '')
            );
        END IF;

        -- 부위를 끝내 못 찾았을 때만 이름에 드러낸다.
        IF v_part_name IS NULL THEN
            v_name := btrim(v_name || ' (부위 미지정)');
        END IF;

        BEGIN
        INSERT INTO public.products (
            wholesaler_id, name, category, subcategory, origin, grade,
            base_price, unit, stock_quantity, is_active, description, created_by, trace_key
        ) VALUES (
            v_wholesaler_id, v_name, v_master.species_group, v_part_name,
            v_origin, v_grade,
            0, COALESCE(NULLIF(v_scan.unit, ''), 'kg'), 0,
            -- 판매중지로 만든다 (설계 결정 4번). 가격만 넣으면 바로 팔리는 상황을 막는다.
            false,
            '입고 스캔으로 자동 등록됨 (이력번호 ' || v_scan.trace_no || ')'
            || CASE
                   WHEN v_part_name IS NULL
                       THEN ' — 이력조회·명세서 어디에도 부위가 없어 비워두었습니다. 채워주세요.'
                   ELSE ''
               END,
            auth.uid(), v_trace_key
        )
        RETURNING id INTO v_product_id;

        v_created := true;
        EXCEPTION WHEN unique_violation THEN
            -- 같은 정체성의 상품을 동시에 만들려던 다른 요청이 먼저 만들었다 — 그 상품을 쓴다.
            -- 소 외 축종은 (출처 키, 부위), 소는 (부위, 등급, 원산지)가 정체성이다(121의 유니크 인덱스와 같은 조건).
            SELECT id INTO v_product_id
            FROM public.products
            WHERE wholesaler_id = v_wholesaler_id
              AND category = v_master.species_group
              AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
              AND (
                  (v_trace_key IS NOT NULL AND trace_key = v_trace_key)
                  OR (v_is_cattle
                      AND unit <> '세트'
                      AND COALESCE(grade, '') = COALESCE(v_grade, '')
                      AND COALESCE(origin, '') = COALESCE(v_origin, ''))
              )
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
        'part_missing', v_part_name IS NULL,
        'needs_price', (SELECT base_price = 0 FROM public.products WHERE id = v_product_id),
        'needs_activation', (SELECT NOT is_active FROM public.products WHERE id = v_product_id)
    );
END;
$function$;
