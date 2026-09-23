-- 명세서 줄에 "부위" 구조화 컬럼 추가 + 자동 상품 생성이 이 값을 쓰도록 확장
-- (2026-09-24, 사장님 확정: "명세가 기반이라 부위 모를 일 없다")
--
-- 배경: 이력조회(공공 API)는 부위를 거의 안 준다(20260930000076에서 이미
-- 확인됨). 그런데 명세서엔 공급처가 "한우 등심 1++"처럼 부위를 적어 보낸다
-- (item_name 원문). 지금까지는 이 값이 화면 표시용일 뿐, 자동 상품 생성
-- (autocreate_product_for_scan)은 이걸 전혀 안 보고 이력조회 결과만 봐서
-- "(부위 미지정)" 상품을 계속 만들었다. 명세서 기반으로 가기로 한 이상
-- 부위를 몰라야 할 이유가 없다는 게 사장님 판단.
--
-- 잠긴 결정: 같은 이력/로트번호가 한 명세서 안에서 서로 다른 부위로 여러
-- 줄에 나뉘어 있으면(한 마리에서 여러 부위가 나오므로 정상) 어느 쪽인지
-- 자동으로 못 고른다 — lookup_product_by_document_trace()가 이미 쓰는
-- "서로 다른 값이 섞이면 NULL"(되묻는다) 원칙을 그대로 따른다.

ALTER TABLE public.inbound_document_lines
    ADD COLUMN IF NOT EXISTS part_name TEXT;

COMMENT ON COLUMN public.inbound_document_lines.part_name IS
    '부위(안심/등심 등). 보통 품목명(item_name)에 같이 적혀 오는 걸 사람이 화면에서 뽑아 적는다. 자동 상품 생성이 이 값을 이력조회 부위 대신 쓴다.';


-- 명세서에서 딱 하나의 부위 값으로 좁혀지는지 본다. 두 개 이상 섞이면 NULL
-- (되묻는다) — lookup_product_by_document_trace()와 같은 판정 기준.
CREATE OR REPLACE FUNCTION public.lookup_document_part_name(p_wholesaler_id UUID, p_trace_no TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_distinct INT;
    v_part     TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    SELECT count(DISTINCT l.part_name) INTO v_distinct
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND l.trace_no = btrim(p_trace_no)
      AND l.part_name IS NOT NULL
      AND btrim(l.part_name) <> '';

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    SELECT DISTINCT l.part_name INTO v_part
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND l.trace_no = btrim(p_trace_no)
      AND l.part_name IS NOT NULL
      AND btrim(l.part_name) <> '';

    RETURN v_part;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.lookup_document_part_name(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_document_part_name(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.lookup_document_part_name(UUID, TEXT) IS
    '명세서에서 이 이력/로트번호에 딱 하나로 좁혀지는 부위 값. 여러 값이 섞이면 NULL(되묻는다).';


-- autocreate_product_for_scan이 이력조회 부위가 없을 때 명세서 부위를 대신
-- 쓰도록 확장. 기존 함수 몸체(20260930000076)에서 부위 결정 부분만 바꾼다.
CREATE OR REPLACE FUNCTION public.autocreate_product_for_scan(p_scan_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_master        public.master_livestock%ROWTYPE;
    v_product_id    UUID;
    v_part_name     TEXT;
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

    -- 부위가 NULL인 상품끼리도 재사용되도록 COALESCE로 비교한다.
    -- 보관된 상품도 대상에 넣는다 — 같은 조합을 다시 찍었으면 보관을 푸는 게 맞다.
    SELECT id INTO v_product_id
    FROM public.products
    WHERE wholesaler_id = v_wholesaler_id
      AND category = v_master.species_group
      AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
      AND COALESCE(grade, '') = COALESCE(v_master.grade, '')
    ORDER BY archived_at NULLS FIRST
    LIMIT 1;

    IF v_product_id IS NULL THEN
        v_name := btrim(
            COALESCE(NULLIF(v_master.species, ''), v_master.species_group)
            || COALESCE(' ' || v_part_name, '')
            || COALESCE(' ' || NULLIF(v_master.grade, ''), '')
        );

        -- 부위를 끝내 못 찾았을 때만 이름에 드러낸다.
        IF v_part_name IS NULL THEN
            v_name := v_name || ' (부위 미지정)';
        END IF;

        v_origin := CASE
            WHEN v_master.trace_kind = 'imported'
                THEN COALESCE(NULLIF(v_master.origin_country, ''), '수입산')
            ELSE '국내산'
        END;

        INSERT INTO public.products (
            wholesaler_id, name, category, subcategory, origin, grade,
            base_price, unit, stock_quantity, is_active, description, created_by
        ) VALUES (
            v_wholesaler_id, v_name, v_master.species_group, v_part_name,
            v_origin, v_master.grade,
            0, COALESCE(NULLIF(v_scan.unit, ''), 'kg'), 0,
            -- 판매중지로 만든다 (설계 결정 4번). 가격만 넣으면 바로 팔리는 상황을 막는다.
            false,
            '입고 스캔으로 자동 등록됨 (이력번호 ' || v_scan.trace_no || ')'
            || CASE
                   WHEN v_part_name IS NULL
                       THEN ' — 이력조회·명세서 어디에도 부위가 없어 비워두었습니다. 채워주세요.'
                   ELSE ''
               END,
            auth.uid()
        )
        RETURNING id INTO v_product_id;

        v_created := true;

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
$$;

REVOKE EXECUTE ON FUNCTION public.autocreate_product_for_scan(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.autocreate_product_for_scan(UUID) TO authenticated;
