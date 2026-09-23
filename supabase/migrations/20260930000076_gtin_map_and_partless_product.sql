-- 부위 없는 상품 자동 생성 + 바코드 상품코드(GTIN)로 부위 알아내기 (30단계)
--
-- 배경: 실제 공공 이력조회 응답을 확인해보니 **부위(part_name)가 오지 않는다.**
-- 적재된 레코드(002141592286)가 한우/소/1+/도축일까지는 주는데 부위는 비어 있다.
-- 이력번호는 소 한 마리를 가리키는 번호지 그 소에서 나온 등심·채끝을 구분하는
-- 번호가 아니라서 애초에 올 수가 없는 값이다.
--
-- 그 결과 8단계에서 만든 "이력으로 상품 자동 생성"이 실질적으로 한 번도 동작하지
-- 않는다 — 축종과 부위가 둘 다 있어야 만들도록 잠가뒀기 때문이다. 스캔은 전부
-- PENDING_MAPPING으로 남고, 상품이 하나도 없는 신규 업체는 고를 것조차 없다.
--
-- 사장님 결정 (2026-09-23):
--   1. 부위가 없어도 상품은 만든다. 있는 값만 채우고 부위는 비운다. 다만 이름에
--      "(부위 미지정)"을 붙여 나중에 뭐가 빠진 상품인지 알 수 있게 한다.
--   2. 바코드의 상품코드(GTIN)를 부위 구분에 쓴다. 이력번호가 소를 가리킨다면
--      GTIN은 공급처가 "이건 등심 박스"라고 부여한 코드다. 한 번 알려주면
--      다음부터 자동으로 붙는다.


-- --------------------------------------------------------------------
-- 1. 스캔에 바코드 상품코드를 남긴다
-- --------------------------------------------------------------------
-- 나중에 사람이 상품을 지정할 때 "그 박스의 GTIN이 무엇이었는지"를 알아야
-- 학습할 수 있다. 파서(barcode-parser.ts)는 이미 GTIN을 뽑고 있었지만 쓰지
-- 않고 버리고 있었다.
ALTER TABLE public.inbound_scans
    ADD COLUMN IF NOT EXISTS gtin TEXT;

COMMENT ON COLUMN public.inbound_scans.gtin IS
    'GS1-128 라벨의 상품코드(AI 01). 공급처가 부여한 품목 구분자 — 이력번호는 개체를, 이건 부위를 가리킨다.';


-- --------------------------------------------------------------------
-- 2. GTIN → 우리 상품 학습
-- --------------------------------------------------------------------
-- trace_product_map이 "축종+부위+등급 → 상품"을 학습하는 것과 같은 패턴인데,
-- 부위가 안 오는 현실에서 실제로 동작하는 쪽이 이것이다. GTIN은 공급처가 품목을
-- 구분해 붙인 코드라 부위보다 오히려 정확하다(같은 등심이라도 규격이 다르면
-- 코드가 다르다).
CREATE TABLE IF NOT EXISTS public.gtin_product_map (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    gtin          TEXT NOT NULL,
    product_id    UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    -- 참고용 — 이 코드를 처음 본 박스의 이력번호.
    sample_trace_no TEXT,
    created_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (wholesaler_id, gtin)
);

ALTER TABLE public.gtin_product_map ENABLE ROW LEVEL SECURITY;

-- 재고가 어느 상품에 붙을지를 좌우하는 값이라 쓰기는 RPC로만 한다
-- (trace_product_map과 같은 기준 — livestock 설계 결정 6번).
DROP POLICY IF EXISTS "Gtin map viewable by owner, org staff, or admin" ON public.gtin_product_map;
CREATE POLICY "Gtin map viewable by owner, org staff, or admin"
ON public.gtin_product_map FOR SELECT USING (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
    OR public.get_current_role() = 'super_admin'
);

GRANT SELECT ON public.gtin_product_map TO authenticated;
GRANT ALL    ON public.gtin_product_map TO service_role;

DROP TRIGGER IF EXISTS trg_gtin_product_map_updated_at ON public.gtin_product_map;
CREATE TRIGGER trg_gtin_product_map_updated_at
    BEFORE UPDATE ON public.gtin_product_map
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- --------------------------------------------------------------------
-- 3. GTIN으로 상품 찾기 / 학습하기
-- --------------------------------------------------------------------
-- 입고는 현장 작업이라 staff까지 허용한다(스캔과 같은 기준). 상품 마스터를
-- 고치는 게 아니라 "이 코드가 어느 상품인지" 표시만 남기는 일이다.
CREATE OR REPLACE FUNCTION public.lookup_product_by_gtin(p_gtin TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_product_id    UUID;
BEGIN
    IF p_gtin IS NULL OR btrim(p_gtin) = '' THEN
        RETURN NULL;
    END IF;

    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- 보관된 상품에는 붙이지 않는다 — 치운 상품에 재고가 다시 쌓이면 사고다.
    SELECT m.product_id INTO v_product_id
    FROM public.gtin_product_map m
    JOIN public.products p ON p.id = m.product_id
    WHERE m.wholesaler_id = v_wholesaler_id
      AND m.gtin = btrim(p_gtin)
      AND p.archived_at IS NULL;

    RETURN v_product_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.lookup_product_by_gtin(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_product_by_gtin(TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION public.learn_gtin_product(p_scan_id UUID, p_product_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id;

    -- GTIN이 없는 박스(순수 이력번호만 찍은 경우)는 학습할 게 없다.
    IF v_scan.id IS NULL OR v_scan.gtin IS NULL OR btrim(v_scan.gtin) = '' THEN
        RETURN false;
    END IF;

    -- 남의 상품에 붙이지 못하게 막는다.
    IF NOT EXISTS (
        SELECT 1 FROM public.products
        WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id
    ) THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    INSERT INTO public.gtin_product_map (
        wholesaler_id, gtin, product_id, sample_trace_no, created_by
    ) VALUES (
        v_wholesaler_id, btrim(v_scan.gtin), p_product_id, v_scan.trace_no, auth.uid()
    )
    ON CONFLICT (wholesaler_id, gtin)
    DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now();

    RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.learn_gtin_product(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.learn_gtin_product(UUID, UUID) TO authenticated;


-- --------------------------------------------------------------------
-- 4. 부위가 없어도 상품을 만든다
-- --------------------------------------------------------------------
-- 8단계의 잠긴 결정 1번("축종과 부위가 둘 다 있을 때만 생성")을 뒤집는다.
-- 그 결정의 근거는 "부위를 모르면 반쪽 상품이 양산된다"였는데, 실제로는 부위가
-- 아예 오지 않아 기능 자체가 죽어 있었다. 반쪽 상품이라도 만들어 두고 사람이
-- 부위를 채우는 쪽이 낫다는 판단(사장님 확정).
--
-- 자동 학습(trace_product_map)은 여전히 부위가 있을 때만 걸린다 — 부위 없이
-- 학습하면 등심과 안심이 한 상품에 섞인다. 그 가드는 resolve_inbound_mapping에
-- 이미 있으므로 여기서 건드리지 않는다.
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

    -- 축종조차 모르면 만들 수 없다. 이름도 분류도 세울 수 없기 때문이다.
    IF v_master.species_group IS NULL THEN
        RETURN jsonb_build_object('created', false, 'reason', 'INSUFFICIENT_TRACE_INFO');
    END IF;

    -- 부위가 NULL인 상품끼리도 재사용되도록 COALESCE로 비교한다.
    -- 보관된 상품도 대상에 넣는다 — 같은 조합을 다시 찍었으면 보관을 푸는 게 맞다.
    SELECT id INTO v_product_id
    FROM public.products
    WHERE wholesaler_id = v_wholesaler_id
      AND category = v_master.species_group
      AND COALESCE(subcategory, '') = COALESCE(v_master.part_name, '')
      AND COALESCE(grade, '') = COALESCE(v_master.grade, '')
    ORDER BY archived_at NULLS FIRST
    LIMIT 1;

    IF v_product_id IS NULL THEN
        v_name := btrim(
            COALESCE(NULLIF(v_master.species, ''), v_master.species_group)
            || COALESCE(' ' || NULLIF(v_master.part_name, ''), '')
            || COALESCE(' ' || NULLIF(v_master.grade, ''), '')
        );

        -- 부위를 모른 채 만든 상품은 이름에 드러낸다. 나중에 목록에서 "뭘 채워야
        -- 하는 상품인지"가 바로 보여야 한다(사장님 확정).
        IF v_master.part_name IS NULL OR btrim(v_master.part_name) = '' THEN
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
            v_wholesaler_id, v_name, v_master.species_group,
            NULLIF(btrim(COALESCE(v_master.part_name, '')), ''),
            v_origin, v_master.grade,
            0, COALESCE(NULLIF(v_scan.unit, ''), 'kg'), 0,
            -- 판매중지로 만든다 (설계 결정 4번). 가격만 넣으면 바로 팔리는 상황을 막는다.
            false,
            '입고 스캔으로 자동 등록됨 (이력번호 ' || v_scan.trace_no || ')'
            || CASE
                   WHEN v_master.part_name IS NULL
                       THEN ' — 이력조회에 부위가 없어 부위를 비워두었습니다. 채워주세요.'
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
        'part_missing', (v_master.part_name IS NULL OR btrim(v_master.part_name) = ''),
        'needs_price', (SELECT base_price = 0 FROM public.products WHERE id = v_product_id),
        'needs_activation', (SELECT NOT is_active FROM public.products WHERE id = v_product_id)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.autocreate_product_for_scan(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.autocreate_product_for_scan(UUID) TO authenticated;


COMMENT ON TABLE public.gtin_product_map IS
    '바코드 상품코드(GTIN) → 우리 상품. 이력조회가 부위를 주지 않아 실제로 동작하는 학습 경로다.';


-- --------------------------------------------------------------------
-- 5. 스캔에 바코드 상품코드 기록
-- --------------------------------------------------------------------
-- inbound_scans는 RLS가 SELECT만 허용하므로(설계 결정 6번) 앱에서 직접 UPDATE할
-- 수 없다. record_inbound_scan_base를 통째로 고치는 대신 작은 RPC를 따로 둔다 —
-- 그 함수는 중복 판정·예외 기록까지 얽혀 있어 시그니처를 건드리면 호출부가
-- 전부 흔들린다. GTIN은 재고 수량에 직접 영향을 주지 않는 참고 값이다.
CREATE OR REPLACE FUNCTION public.set_scan_gtin(p_scan_id UUID, p_gtin TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
BEGIN
    IF p_gtin IS NULL OR btrim(p_gtin) = '' THEN
        RETURN false;
    END IF;

    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    UPDATE public.inbound_scans
    SET gtin = btrim(p_gtin), updated_at = now()
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id AND gtin IS NULL;

    RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_scan_gtin(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_scan_gtin(UUID, TEXT) TO authenticated;
