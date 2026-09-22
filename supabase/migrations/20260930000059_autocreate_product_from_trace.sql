-- ====================================================================
-- 스캔한 이력 정보로 상품을 자동 생성한다
--
-- 처음 취급하는 고기를 찍으면 지금까지는 PENDING_MAPPING으로 남고, 공급사가
-- 상품관리로 나가 상품을 만들고 입고 화면으로 돌아와 다시 골라야 했다.
-- 공공 API가 이미 축종·부위·등급을 알려주는데 그걸 사람이 다시 입력하는 셈이라
-- 왕복 자체를 없앤다.
--
-- 잠긴 설계 결정:
--
--  1. 축종(species_group)과 부위(part_name)가 둘 다 있을 때만 자동 생성한다.
--     부위를 모르면 "한우 1++" 같은 반쪽 상품이 양산된다. 그 경우는 기존대로
--     사용자에게 되묻는다.
--
--  2. 판매가는 0으로 만든다. 값을 대신 정해줄 수는 없고, 0원 상품은
--     이미 고객에게 노출되지 않으므로(20260930000058) 안전하다. 공급사가
--     상품관리에서 값을 매기는 순간 미니샵에 나타난다.
--
--  3. 같은 조합(축종+부위+등급)의 상품이 이미 있으면 새로 만들지 않고 그걸 쓴다.
--     이름만 다르게 등록해 둔 경우까지는 못 잡지만, 스캔이 만든 중복은 막는다.
-- ====================================================================
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

    -- 부위를 모르면 자동 생성하지 않는다 (설계 결정 1번).
    IF v_master.species_group IS NULL OR v_master.part_name IS NULL THEN
        RETURN jsonb_build_object('created', false, 'reason', 'INSUFFICIENT_TRACE_INFO');
    END IF;

    -- 같은 조합의 상품이 이미 있으면 재사용한다 (설계 결정 3번).
    SELECT id INTO v_product_id
    FROM public.products
    WHERE wholesaler_id = v_wholesaler_id
      AND category = v_master.species_group
      AND subcategory = v_master.part_name
      AND COALESCE(grade, '') = COALESCE(v_master.grade, '')
    LIMIT 1;

    IF v_product_id IS NULL THEN
        -- 이름은 "한우 등심 1++"처럼 사람이 읽는 순서로 만든다.
        -- species(원문 축종, 예: 한우)가 있으면 그걸 쓰고 없으면 분류값(소)을 쓴다.
        v_name := btrim(
            COALESCE(NULLIF(v_master.species, ''), v_master.species_group)
            || ' ' || v_master.part_name
            || COALESCE(' ' || NULLIF(v_master.grade, ''), '')
        );

        v_origin := CASE
            WHEN v_master.trace_kind = 'imported'
                THEN COALESCE(NULLIF(v_master.origin_country, ''), '수입산')
            ELSE '국내산'
        END;

        INSERT INTO public.products (
            wholesaler_id, name, category, subcategory, origin, grade,
            base_price, unit, stock_quantity, is_active, description, created_by
        ) VALUES (
            v_wholesaler_id, v_name, v_master.species_group, v_master.part_name,
            v_origin, v_master.grade,
            -- 판매가는 사람이 정해야 한다. 0원은 고객에게 노출되지 않는다(설계 결정 2번).
            0, COALESCE(NULLIF(v_scan.unit, ''), 'kg'), 0, true,
            '입고 스캔으로 자동 등록됨 (이력번호 ' || v_scan.trace_no || ')',
            auth.uid()
        )
        RETURNING id INTO v_product_id;

        v_created := true;
    END IF;

    -- 상품이 정해졌으니 기존 확정 경로를 그대로 탄다 (원장 기록 + 매핑 학습).
    PERFORM public.resolve_inbound_mapping(p_scan_id, v_product_id, true);

    RETURN jsonb_build_object(
        'created', v_created,
        'product_id', v_product_id,
        'product_name', (SELECT name FROM public.products WHERE id = v_product_id),
        'needs_price', (SELECT base_price = 0 FROM public.products WHERE id = v_product_id)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.autocreate_product_for_scan(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.autocreate_product_for_scan(UUID) TO authenticated;
