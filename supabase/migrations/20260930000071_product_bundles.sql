-- ====================================================================
-- 자체 세트 상품 (BOM) + 이력 역추적 (23단계)
--
-- 도매업체가 임의로 만든 세트("삼겹살+목살 실속세트")를 플랫폼 안에서
-- 자체 상품코드/세트번호로 발행하고, 그 박스 안에 실제로 들어간 고기의
-- 정부 이력번호를 1:N으로 묶어 남긴다. 나중에 이력 추적이 들어왔을 때
-- "이 세트에 들어간 고기가 원래 어떤 이력번호였는지" 역추적이 된다.
--
-- 잠긴 설계 결정 (docs/livestock-inbound-tracking.md 23단계 참고):
--
--  1. 세트 상품 자체는 그냥 products 한 행이다. 미니샵·발주·맞춤단가·명세서가
--     코드 변경 없이 그대로 돈다. "세트인가"는 product_bundles 행이 있느냐로 본다
--     — products 스키마는 여전히 건드리지 않는다(1단계 설계 결정 3번).
--
--  2. 세트 박스 한 개도 inbound_scans 한 행이다. 재고 단위는 여전히 "박스 한 개"라
--     선입선출·출고 스캔·피킹 목록·라벨이 전부 기존 기계장치를 그대로 쓴다.
--     자체 세트번호(SET-YYMMDD-NNN)가 그 박스의 trace_no 자리에 들어간다.
--
--  3. 세트 상품의 재고 단위는 kg이 아니라 "세트 1개"다. 세트는 규격 상품이라
--     "실속세트 1박스 45,000원"으로 팔지 kg으로 팔지 않는다. 중량으로 재고를 세면
--     45,000원짜리 세트가 0.7세트만큼 팔릴 수 있다. 실제 중량은 박스마다 달라서
--     bundle_assemblies.total_weight에 따로 적고 라벨·명세서에 쓴다.
--
--  4. 세트에 들어가는 고기는 반드시 "박스"에서 나온다. 박스로 못 채우는 분량
--     (기초재고 등 이력번호 없는 재고)으로는 세트를 만들지 않는다 — 이력번호가
--     없는 고기를 세트에 넣는 순간 역추적이 끊기고, 그게 이 기능의 존재 이유다.
--
--  5. 유통기한이 지난 박스는 세트 제작에 쓰지 않는다. 출고 차단(22단계)과 같은
--     논리다. 재포장으로 기한을 리셋하는 경로를 만들면 안 된다.
--     세트 박스의 기한은 구성 박스 중 가장 이른 기한을 물려받는다.
--
--  6. 중첩 세트(세트를 구성품으로 하는 세트)는 금지한다. 역추적이 재귀가 되면
--     명세서·라벨·단속 대응 질의가 전부 복잡해진다. 1단계 전개만 지원한다.
--
--  7. 원장은 고쳐 쓰지 않는다(15단계와 같은 원칙). 세트 해체는 행 수정이 아니라
--     반대 부호 행(BUNDLE_DISASSEMBLE / BUNDLE_RESTORE) 추가다.
--
--  8. 이미 입출고 기록이 있는 상품은 세트 상품으로 지정할 수 없다. kg으로 쌓인
--     재고와 세트 개수가 한 컬럼에서 뒤섞인다.
-- ====================================================================


-- --------------------------------------------------------------------
-- 0. 기존 CHECK 제약 확장
-- --------------------------------------------------------------------

-- 세트 박스는 사람이 찍은 게 아니라 제작으로 생긴 박스다. 입고 목록에서 구분된다.
ALTER TABLE public.inbound_scans DROP CONSTRAINT IF EXISTS inbound_scans_scan_type_check;
ALTER TABLE public.inbound_scans ADD CONSTRAINT inbound_scans_scan_type_check
    CHECK (scan_type IN ('BARCODE_SCAN', 'CAMERA', 'EXCEL', 'MANUAL', 'BUNDLE'));

ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_event_type_check;
ALTER TABLE public.stock_ledger ADD CONSTRAINT stock_ledger_event_type_check
    CHECK (event_type IN (
        'INBOUND', 'INBOUND_VOID',
        'OPENING_BALANCE',
        'ORDER_OUT', 'ORDER_RESTORE',
        'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN',
        'ADJUSTMENT', 'LOSS',
        -- 세트 제작: 구성품이 나가고(-) 세트가 생긴다(+)
        'BUNDLE_CONSUME', 'BUNDLE_ASSEMBLE',
        -- 세트 해체: 세트가 사라지고(-) 구성품이 돌아온다(+)
        'BUNDLE_DISASSEMBLE', 'BUNDLE_RESTORE'
    ));

ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_source_type_check;
ALTER TABLE public.stock_ledger ADD CONSTRAINT stock_ledger_source_type_check
    CHECK (source_type IN ('inbound_scan', 'order', 'product', 'manual', 'bundle'));


-- --------------------------------------------------------------------
-- 1. PRODUCT_BUNDLES — 세트 상품 정의 (products 한 행에 얹는다)
-- --------------------------------------------------------------------
CREATE TABLE public.product_bundles (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    -- 이 세트를 대표하는 판매 상품. 상품 1개당 세트 정의 1개.
    product_id    UUID NOT NULL UNIQUE REFERENCES public.products(id) ON DELETE CASCADE,
    -- 업체가 직접 쓰는 자체 상품코드 (BND-0001). 업체 안에서 유일하다.
    bundle_code   TEXT NOT NULL,
    memo          TEXT,
    created_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_product_bundles_code
    ON public.product_bundles (wholesaler_id, upper(bundle_code));

ALTER TABLE public.product_bundles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Product bundles viewable by owner, org staff, or admin" ON public.product_bundles
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR public.get_current_role() = 'super_admin'
    );

DROP TRIGGER IF EXISTS trg_product_bundles_updated_at ON public.product_bundles;
CREATE TRIGGER trg_product_bundles_updated_at
    BEFORE UPDATE ON public.product_bundles
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- --------------------------------------------------------------------
-- 2. PRODUCT_BUNDLE_ITEMS — BOM. 세트 1개에 들어가는 구성품과 소요량
-- --------------------------------------------------------------------
CREATE TABLE public.product_bundle_items (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bundle_id            UUID NOT NULL REFERENCES public.product_bundles(id) ON DELETE CASCADE,
    component_product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
    -- 세트 1개당 소요량 (구성품의 단위 기준, 보통 kg)
    quantity             NUMERIC(10, 3) NOT NULL CHECK (quantity > 0),
    sort_order           INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (bundle_id, component_product_id)
);

CREATE INDEX idx_product_bundle_items_component
    ON public.product_bundle_items (component_product_id);

ALTER TABLE public.product_bundle_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Bundle items viewable via parent bundle" ON public.product_bundle_items
    FOR SELECT USING (bundle_id IN (SELECT id FROM public.product_bundles));

DROP TRIGGER IF EXISTS trg_product_bundle_items_updated_at ON public.product_bundle_items;
CREATE TRIGGER trg_product_bundle_items_updated_at
    BEFORE UPDATE ON public.product_bundle_items
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- --------------------------------------------------------------------
-- 3. BUNDLE_ASSEMBLIES — 세트 제작 1건 = 세트 박스 1개
-- --------------------------------------------------------------------
CREATE TABLE public.bundle_assemblies (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    bundle_id     UUID NOT NULL REFERENCES public.product_bundles(id) ON DELETE RESTRICT,
    -- 자체 세트번호. 이 박스의 바코드에 찍히고 inbound_scans.trace_no 자리에도 들어간다.
    set_no        TEXT NOT NULL UNIQUE,
    set_scan_id   UUID NOT NULL REFERENCES public.inbound_scans(id) ON DELETE RESTRICT,
    -- 구성품 실중량 합계. 재고는 "세트 1개"로 세지만 라벨·명세서에는 중량이 필요하다.
    total_weight  NUMERIC(10, 3) NOT NULL CHECK (total_weight > 0),
    -- 구성 박스 중 가장 이른 유통기한 (설계 결정 5번)
    best_before   DATE,
    status        TEXT NOT NULL DEFAULT 'NORMAL' CHECK (status IN ('NORMAL', 'VOIDED')),
    assembled_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    voided_at     TIMESTAMPTZ
);

CREATE INDEX idx_bundle_assemblies_recent
    ON public.bundle_assemblies (wholesaler_id, created_at DESC);

CREATE INDEX idx_bundle_assemblies_bundle
    ON public.bundle_assemblies (bundle_id, created_at DESC);

ALTER TABLE public.bundle_assemblies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Bundle assemblies viewable by owner, org staff, or admin" ON public.bundle_assemblies
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR public.get_current_role() = 'super_admin'
    );


-- --------------------------------------------------------------------
-- 4. BUNDLE_ASSEMBLY_SOURCES — 세트 박스 ↔ 원본 이력번호 (Parent-Child)
--    이 테이블이 이 기능의 전부다. 단속이 들어왔을 때 내미는 근거다.
-- --------------------------------------------------------------------
CREATE TABLE public.bundle_assembly_sources (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assembly_id          UUID NOT NULL REFERENCES public.bundle_assemblies(id) ON DELETE CASCADE,
    component_product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
    -- 어느 박스에서 잘라 넣었는지. 입출고 기록이라 지워지면 안 된다.
    source_scan_id       UUID NOT NULL REFERENCES public.inbound_scans(id) ON DELETE RESTRICT,
    -- 그 시점의 이력번호 스냅샷. 조회를 단순하게 하고 사실을 고정한다.
    trace_no             TEXT NOT NULL,
    weight               NUMERIC(10, 3) NOT NULL CHECK (weight > 0),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (assembly_id, source_scan_id)
);

CREATE INDEX idx_bundle_sources_trace ON public.bundle_assembly_sources (trace_no);
CREATE INDEX idx_bundle_sources_scan  ON public.bundle_assembly_sources (source_scan_id);

ALTER TABLE public.bundle_assembly_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Bundle sources viewable via parent assembly" ON public.bundle_assembly_sources
    FOR SELECT USING (assembly_id IN (SELECT id FROM public.bundle_assemblies));


-- --------------------------------------------------------------------
-- 5. 헬퍼 — 지금 재고로 몇 세트까지 만들 수 있나
--    기한이 지난 박스는 세지 않는다(설계 결정 5번). 박스 없는 재고도 세지
--    않는다(설계 결정 4번) — 그래서 products.stock_quantity가 아니라
--    inbound_scans.remaining_weight를 본다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bundle_buildable_sets(p_bundle_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(MIN(FLOOR(avail.available / i.quantity))::INTEGER, 0)
    FROM public.product_bundle_items i
    JOIN public.product_bundles b ON b.id = i.bundle_id
    CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(s.remaining_weight), 0) AS available
        FROM public.inbound_scans s
        WHERE s.wholesaler_id = b.wholesaler_id
          AND s.product_id = i.component_product_id
          AND s.status = 'NORMAL'
          AND s.remaining_weight > 0
          AND (s.best_before IS NULL OR s.best_before >= CURRENT_DATE)
    ) avail
    WHERE i.bundle_id = p_bundle_id;
$$;

REVOKE EXECUTE ON FUNCTION public.bundle_buildable_sets(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bundle_buildable_sets(UUID) TO authenticated;


-- --------------------------------------------------------------------
-- 6. SAVE_PRODUCT_BUNDLE — 세트 구성(BOM) 저장. 상품을 새로 만들 수도 있다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_product_bundle(
    p_items       JSONB,
    p_bundle_id   UUID    DEFAULT NULL,
    p_product_id  UUID    DEFAULT NULL,
    p_name        TEXT    DEFAULT NULL,
    p_base_price  NUMERIC DEFAULT NULL,
    p_bundle_code TEXT    DEFAULT NULL,
    p_memo        TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_bundle        public.product_bundles%ROWTYPE;
    v_product_id    UUID;
    v_bundle_id     UUID;
    v_code          TEXT;
    v_item          RECORD;
    v_component     public.products%ROWTYPE;
    v_category      TEXT;
    v_origin        TEXT;
    v_created       BOOLEAN := false;
    v_count         INTEGER;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'BUNDLE_HAS_NO_ITEMS';
    END IF;

    -- ① 대상 세트/상품 결정 -------------------------------------------------
    IF p_bundle_id IS NOT NULL THEN
        SELECT * INTO v_bundle FROM public.product_bundles WHERE id = p_bundle_id;

        IF v_bundle.id IS NULL OR v_bundle.wholesaler_id <> v_wholesaler_id THEN
            RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
        END IF;

        v_bundle_id  := v_bundle.id;
        v_product_id := v_bundle.product_id;

    ELSIF p_product_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.product_bundles WHERE product_id = p_product_id) THEN
            RAISE EXCEPTION 'ALREADY_A_BUNDLE';
        END IF;

        PERFORM 1 FROM public.products
        WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id AND archived_at IS NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
        END IF;

        -- kg으로 쌓인 재고와 세트 개수가 한 컬럼에서 뒤섞인다 (설계 결정 8번).
        IF public.product_has_stock_history(p_product_id) THEN
            RAISE EXCEPTION 'PRODUCT_HAS_STOCK_HISTORY';
        END IF;

        -- 남의 세트의 구성품으로 이미 쓰이고 있으면 중첩이 된다 (설계 결정 6번).
        IF EXISTS (SELECT 1 FROM public.product_bundle_items WHERE component_product_id = p_product_id) THEN
            RAISE EXCEPTION 'COMPONENT_CANNOT_BE_BUNDLE';
        END IF;

        v_product_id := p_product_id;

    ELSE
        IF COALESCE(btrim(p_name), '') = '' THEN
            RAISE EXCEPTION 'NAME_REQUIRED';
        END IF;

        -- 축종·원산지는 구성품에서 물려받는다. 섞여 있으면 '혼합'.
        SELECT
            MIN(p.category),
            CASE WHEN COUNT(DISTINCT p.origin) = 1 THEN MIN(p.origin) ELSE '혼합' END
        INTO v_category, v_origin
        FROM jsonb_array_elements(p_items) e
        JOIN public.products p ON p.id = (e ->> 'product_id')::uuid
        WHERE p.wholesaler_id = v_wholesaler_id;

        IF v_category IS NULL THEN
            RAISE EXCEPTION 'COMPONENT_NOT_FOUND';
        END IF;

        INSERT INTO public.products (
            wholesaler_id, name, category, origin, base_price, unit,
            stock_quantity, is_active, description
        ) VALUES (
            v_wholesaler_id, btrim(p_name), v_category, v_origin,
            GREATEST(COALESCE(p_base_price, 0), 0), '세트',
            0,
            -- 자동 생성 상품과 같은 정책: 가격을 넣고 직접 켜야 노출된다(12단계).
            COALESCE(p_base_price, 0) > 0,
            NULL
        )
        RETURNING id INTO v_product_id;

        v_created := true;
    END IF;

    -- ② 자체 상품코드 ------------------------------------------------------
    v_code := upper(btrim(COALESCE(p_bundle_code, '')));

    IF v_code = '' THEN
        IF v_bundle.bundle_code IS NOT NULL THEN
            v_code := v_bundle.bundle_code;
        ELSE
            -- 업체 안에서 1번부터 센다. 동시 발급은 자문 잠금으로 막는다.
            PERFORM pg_advisory_xact_lock(hashtext('bundle_code:' || v_wholesaler_id::text));

            SELECT COUNT(*) + 1 INTO v_count
            FROM public.product_bundles WHERE wholesaler_id = v_wholesaler_id;

            v_code := 'BND-' || lpad(v_count::text, 4, '0');
        END IF;
    END IF;

    -- ③ 세트 정의 저장 -----------------------------------------------------
    IF v_bundle_id IS NULL THEN
        INSERT INTO public.product_bundles (wholesaler_id, product_id, bundle_code, memo, created_by)
        VALUES (v_wholesaler_id, v_product_id, v_code, NULLIF(btrim(COALESCE(p_memo, '')), ''), auth.uid())
        RETURNING id INTO v_bundle_id;
    ELSE
        UPDATE public.product_bundles
        SET bundle_code = v_code,
            memo = NULLIF(btrim(COALESCE(p_memo, '')), '')
        WHERE id = v_bundle_id;
    END IF;

    -- ④ 세트 상품의 단위는 '세트'로 맞춘다 (설계 결정 3번) ------------------
    UPDATE public.products SET unit = '세트' WHERE id = v_product_id AND unit <> '세트';

    -- ⑤ 구성품 교체 --------------------------------------------------------
    DELETE FROM public.product_bundle_items
    WHERE bundle_id = v_bundle_id
      AND component_product_id NOT IN (
          SELECT (e ->> 'product_id')::uuid FROM jsonb_array_elements(p_items) e
      );

    FOR v_item IN
        SELECT
            (e ->> 'product_id')::uuid AS product_id,
            COALESCE((e ->> 'quantity')::numeric, 0) AS quantity,
            (ordinality - 1)::int AS sort_order
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ordinality)
    LOOP
        IF v_item.quantity <= 0 THEN
            RAISE EXCEPTION 'INVALID_COMPONENT_QUANTITY';
        END IF;

        IF v_item.product_id = v_product_id THEN
            RAISE EXCEPTION 'SELF_COMPONENT';
        END IF;

        SELECT * INTO v_component FROM public.products WHERE id = v_item.product_id;

        IF v_component.id IS NULL
           OR v_component.wholesaler_id <> v_wholesaler_id
           OR v_component.archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'COMPONENT_NOT_FOUND';
        END IF;

        -- 세트를 구성품으로 넣는 중첩 세트는 금지 (설계 결정 6번).
        IF EXISTS (SELECT 1 FROM public.product_bundles WHERE product_id = v_item.product_id) THEN
            RAISE EXCEPTION 'NESTED_BUNDLE:%', v_component.name;
        END IF;

        INSERT INTO public.product_bundle_items (bundle_id, component_product_id, quantity, sort_order)
        VALUES (v_bundle_id, v_item.product_id, v_item.quantity, v_item.sort_order)
        ON CONFLICT (bundle_id, component_product_id) DO UPDATE
        SET quantity = EXCLUDED.quantity, sort_order = EXCLUDED.sort_order;
    END LOOP;

    RETURN jsonb_build_object(
        'bundle_id',    v_bundle_id,
        'product_id',   v_product_id,
        'bundle_code',  v_code,
        'created',      v_created,
        'buildable',    public.bundle_buildable_sets(v_bundle_id)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_product_bundle(JSONB, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_product_bundle(JSONB, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT) TO authenticated;


-- --------------------------------------------------------------------
-- 7. DELETE_PRODUCT_BUNDLE — 구성 정의만 지운다. 상품은 남는다.
--    제작 이력이 있으면 막는다 — 역추적 근거가 사라지면 안 된다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_product_bundle(p_bundle_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_bundle        public.product_bundles%ROWTYPE;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    SELECT * INTO v_bundle FROM public.product_bundles WHERE id = p_bundle_id;

    IF v_bundle.id IS NULL OR v_bundle.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
    END IF;

    IF EXISTS (SELECT 1 FROM public.bundle_assemblies WHERE bundle_id = p_bundle_id) THEN
        RAISE EXCEPTION 'BUNDLE_HAS_ASSEMBLIES';
    END IF;

    DELETE FROM public.product_bundles WHERE id = p_bundle_id;

    RETURN jsonb_build_object('deleted', true, 'product_id', v_bundle.product_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_product_bundle(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_product_bundle(UUID) TO authenticated;


-- --------------------------------------------------------------------
-- 8. ASSEMBLE_PRODUCT_BUNDLE — 세트 제작. 한 트랜잭션에서
--      구성품 박스 선입선출 차감(-) → 세트 박스 생성(+) → 원본 매핑 기록
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assemble_product_bundle(
    p_bundle_id UUID,
    p_set_count INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_bundle        public.product_bundles%ROWTYPE;
    v_set_product   public.products%ROWTYPE;
    v_item          RECORD;
    v_box           RECORD;
    v_seq           INTEGER;
    v_prefix        TEXT;
    v_index         INTEGER;
    v_assembly_id   UUID;
    v_scan_id       UUID;
    v_set_no        TEXT;
    v_need          NUMERIC(10, 3);
    v_take          NUMERIC(10, 3);
    v_available     NUMERIC(10, 3);
    v_total         NUMERIC(10, 3);
    v_best_before   DATE;
    v_plan          JSONB;
    v_sets          JSONB := '[]'::jsonb;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_bundle FROM public.product_bundles WHERE id = p_bundle_id;

    IF v_bundle.id IS NULL OR v_bundle.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'BUNDLE_NOT_FOUND';
    END IF;

    IF p_set_count IS NULL OR p_set_count < 1 OR p_set_count > 200 THEN
        RAISE EXCEPTION 'INVALID_SET_COUNT';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.product_bundle_items WHERE bundle_id = p_bundle_id) THEN
        RAISE EXCEPTION 'BUNDLE_HAS_NO_ITEMS';
    END IF;

    SELECT * INTO v_set_product FROM public.products WHERE id = v_bundle.product_id;

    -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 먼저 옮긴다(1단계 설계 결정 11번).
    PERFORM public.ensure_opening_balance(v_bundle.product_id);

    FOR v_item IN
        SELECT component_product_id FROM public.product_bundle_items WHERE bundle_id = p_bundle_id
    LOOP
        PERFORM public.ensure_opening_balance(v_item.component_product_id);
    END LOOP;

    -- 세트번호는 업체별·일자별로 1번부터 센다. 동시 제작은 자문 잠금으로 막는다.
    PERFORM pg_advisory_xact_lock(hashtext('bundle_set_no:' || v_wholesaler_id::text));

    v_prefix := 'SET-' || to_char(now(), 'YYMMDD') || '-';

    SELECT COUNT(*) INTO v_seq
    FROM public.bundle_assemblies
    WHERE wholesaler_id = v_wholesaler_id AND set_no LIKE v_prefix || '%';

    FOR v_index IN 1 .. p_set_count LOOP
        v_assembly_id := gen_random_uuid();
        v_scan_id     := gen_random_uuid();
        v_seq         := v_seq + 1;
        v_set_no      := v_prefix || lpad(v_seq::text, 3, '0');
        v_total       := 0;
        v_best_before := NULL;
        v_plan        := '[]'::jsonb;

        -- 세트 박스 한 개 = inbound_scans 한 행 (설계 결정 2번).
        -- 수량은 "세트 1개"다 (설계 결정 3번) — 중량은 아래에서 따로 집계한다.
        INSERT INTO public.inbound_scans (
            id, wholesaler_id, trace_no, product_id, weight, unit,
            scan_type, status, remaining_weight, memo, scanned_by
        ) VALUES (
            v_scan_id, v_wholesaler_id, v_set_no, v_bundle.product_id, 1, '세트',
            'BUNDLE', 'NORMAL', 1, '세트 제작 · ' || v_bundle.bundle_code, auth.uid()
        );

        FOR v_item IN
            SELECT i.component_product_id, i.quantity, p.name
            FROM public.product_bundle_items i
            JOIN public.products p ON p.id = i.component_product_id
            WHERE i.bundle_id = p_bundle_id
            ORDER BY i.sort_order, p.name
        LOOP
            -- 박스로 채울 수 있는 양만 센다 (설계 결정 4번).
            -- 기한이 지난 박스는 세트에 넣지 않는다 (설계 결정 5번).
            SELECT COALESCE(SUM(remaining_weight), 0) INTO v_available
            FROM public.inbound_scans
            WHERE wholesaler_id = v_wholesaler_id
              AND product_id = v_item.component_product_id
              AND status = 'NORMAL'
              AND remaining_weight > 0
              AND (best_before IS NULL OR best_before >= CURRENT_DATE);

            IF v_available < v_item.quantity THEN
                RAISE EXCEPTION 'INSUFFICIENT_COMPONENT_BOXES:%:%:%',
                    v_item.name, v_available, v_item.quantity;
            END IF;

            v_need := v_item.quantity;

            FOR v_box IN
                SELECT id, trace_no, remaining_weight, best_before
                FROM public.inbound_scans
                WHERE wholesaler_id = v_wholesaler_id
                  AND product_id = v_item.component_product_id
                  AND status = 'NORMAL'
                  AND remaining_weight > 0
                  AND (best_before IS NULL OR best_before >= CURRENT_DATE)
                ORDER BY created_at, id
                FOR UPDATE
            LOOP
                EXIT WHEN v_need <= 0;

                v_take := LEAST(v_box.remaining_weight, v_need);

                UPDATE public.inbound_scans
                SET remaining_weight = remaining_weight - v_take
                WHERE id = v_box.id;

                INSERT INTO public.stock_ledger (
                    wholesaler_id, product_id, inbound_scan_id, qty_delta,
                    event_type, source_type, source_id, reason, created_by
                ) VALUES (
                    v_wholesaler_id, v_item.component_product_id, v_box.id, -v_take,
                    'BUNDLE_CONSUME', 'bundle', v_assembly_id,
                    '세트 제작 · ' || v_set_no, auth.uid()
                );

                v_plan := v_plan || jsonb_build_object(
                    'product_id', v_item.component_product_id,
                    'scan_id',    v_box.id,
                    'trace_no',   v_box.trace_no,
                    'weight',     v_take
                );

                v_total       := v_total + v_take;
                -- LEAST는 NULL을 무시한다 — 기한 없는 박스가 섞여도 가장 이른 날짜가 남는다.
                v_best_before := LEAST(v_best_before, v_box.best_before);
                v_need        := v_need - v_take;
            END LOOP;

            IF v_need > 0 THEN
                RAISE EXCEPTION 'INSUFFICIENT_COMPONENT_BOXES:%:%:%',
                    v_item.name, v_available, v_item.quantity;
            END IF;
        END LOOP;

        INSERT INTO public.bundle_assemblies (
            id, wholesaler_id, bundle_id, set_no, set_scan_id,
            total_weight, best_before, assembled_by
        ) VALUES (
            v_assembly_id, v_wholesaler_id, p_bundle_id, v_set_no, v_scan_id,
            v_total, v_best_before, auth.uid()
        );

        -- 세트 박스 ↔ 원본 이력번호 (이 기능의 전부)
        INSERT INTO public.bundle_assembly_sources (
            assembly_id, component_product_id, source_scan_id, trace_no, weight
        )
        SELECT
            v_assembly_id,
            (e ->> 'product_id')::uuid,
            (e ->> 'scan_id')::uuid,
            e ->> 'trace_no',
            (e ->> 'weight')::numeric
        FROM jsonb_array_elements(v_plan) e;

        UPDATE public.inbound_scans
        SET best_before = v_best_before
        WHERE id = v_scan_id;

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) VALUES (
            v_wholesaler_id, v_bundle.product_id, v_scan_id, 1,
            'BUNDLE_ASSEMBLE', 'bundle', v_assembly_id,
            '세트 제작 · ' || v_set_no, auth.uid()
        );

        v_sets := v_sets || jsonb_build_object(
            'assembly_id',  v_assembly_id,
            'set_no',       v_set_no,
            'total_weight', v_total,
            'best_before',  v_best_before,
            'sources',      jsonb_array_length(v_plan)
        );
    END LOOP;

    PERFORM public.recalc_product_stock(v_bundle.product_id);

    FOR v_item IN
        SELECT component_product_id FROM public.product_bundle_items WHERE bundle_id = p_bundle_id
    LOOP
        PERFORM public.recalc_product_stock(v_item.component_product_id);
    END LOOP;

    RETURN jsonb_build_object(
        'assembled',    p_set_count,
        'product_id',   v_bundle.product_id,
        'product_name', v_set_product.name,
        'sets',         v_sets,
        'buildable',    public.bundle_buildable_sets(p_bundle_id)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assemble_product_bundle(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assemble_product_bundle(UUID, INTEGER) TO authenticated;


-- --------------------------------------------------------------------
-- 9. DISASSEMBLE_BUNDLE_ASSEMBLY — 세트 해체(역분개).
--    원장은 고쳐 쓰지 않고 반대 부호 행을 더한다 (설계 결정 7번).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.disassemble_bundle_assembly(p_assembly_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_assembly      public.bundle_assemblies%ROWTYPE;
    v_bundle        public.product_bundles%ROWTYPE;
    v_scan          public.inbound_scans%ROWTYPE;
    v_source        RECORD;
    v_restored      INTEGER := 0;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    SELECT * INTO v_assembly FROM public.bundle_assemblies WHERE id = p_assembly_id;

    IF v_assembly.id IS NULL OR v_assembly.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'ASSEMBLY_NOT_FOUND';
    END IF;

    IF v_assembly.status <> 'NORMAL' THEN
        RAISE EXCEPTION 'ALREADY_VOIDED';
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = v_assembly.set_scan_id FOR UPDATE;

    -- 일부라도 나간 세트는 해체할 수 없다 (입고 취소와 같은 규칙).
    IF v_scan.status <> 'NORMAL' OR v_scan.remaining_weight < v_scan.weight THEN
        RAISE EXCEPTION 'PARTIALLY_SHIPPED';
    END IF;

    SELECT * INTO v_bundle FROM public.product_bundles WHERE id = v_assembly.bundle_id;

    UPDATE public.inbound_scans
    SET status = 'VOIDED', remaining_weight = 0
    WHERE id = v_scan.id;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) VALUES (
        v_wholesaler_id, v_scan.product_id, v_scan.id, -v_scan.weight,
        'BUNDLE_DISASSEMBLE', 'bundle', p_assembly_id,
        '세트 해체 · ' || v_assembly.set_no, auth.uid()
    );

    FOR v_source IN
        SELECT * FROM public.bundle_assembly_sources WHERE assembly_id = p_assembly_id
    LOOP
        UPDATE public.inbound_scans
        SET remaining_weight = remaining_weight + v_source.weight
        WHERE id = v_source.source_scan_id AND status = 'NORMAL';

        IF NOT FOUND THEN
            RAISE EXCEPTION 'SOURCE_BOX_UNAVAILABLE:%', v_source.trace_no;
        END IF;

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) VALUES (
            v_wholesaler_id, v_source.component_product_id, v_source.source_scan_id, v_source.weight,
            'BUNDLE_RESTORE', 'bundle', p_assembly_id,
            '세트 해체 · ' || v_assembly.set_no, auth.uid()
        );

        PERFORM public.recalc_product_stock(v_source.component_product_id);

        v_restored := v_restored + 1;
    END LOOP;

    UPDATE public.bundle_assemblies
    SET status = 'VOIDED', voided_at = now()
    WHERE id = p_assembly_id;

    PERFORM public.recalc_product_stock(v_scan.product_id);

    RETURN jsonb_build_object(
        'set_no',    v_assembly.set_no,
        'restored',  v_restored,
        'buildable', public.bundle_buildable_sets(v_assembly.bundle_id)
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.disassemble_bundle_assembly(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.disassemble_bundle_assembly(UUID) TO authenticated;


-- --------------------------------------------------------------------
-- 10. 조회 — 세트 목록 / 제작 목록 / 역추적
-- --------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_product_bundles()
RETURNS TABLE (
    bundle_id      UUID,
    bundle_code    TEXT,
    product_id     UUID,
    product_name   TEXT,
    base_price     NUMERIC,
    is_active      BOOLEAN,
    archived_at    TIMESTAMPTZ,
    stock_quantity NUMERIC,
    memo           TEXT,
    components     JSONB,
    buildable      INTEGER,
    on_hand_sets   INTEGER,
    created_at     TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        b.id,
        b.bundle_code,
        b.product_id,
        p.name,
        p.base_price,
        p.is_active,
        p.archived_at,
        p.stock_quantity,
        b.memo,
        COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'product_id',   i.component_product_id,
                       'product_name', cp.name,
                       'quantity',     i.quantity,
                       'unit',         cp.unit,
                       'available',    (
                           SELECT COALESCE(SUM(s.remaining_weight), 0)
                           FROM public.inbound_scans s
                           WHERE s.wholesaler_id = b.wholesaler_id
                             AND s.product_id = i.component_product_id
                             AND s.status = 'NORMAL'
                             AND s.remaining_weight > 0
                             AND (s.best_before IS NULL OR s.best_before >= CURRENT_DATE)
                       )
                   ) ORDER BY i.sort_order, cp.name)
            FROM public.product_bundle_items i
            JOIN public.products cp ON cp.id = i.component_product_id
            WHERE i.bundle_id = b.id
        ), '[]'::jsonb),
        public.bundle_buildable_sets(b.id),
        (
            SELECT COUNT(*)::INTEGER
            FROM public.bundle_assemblies a
            JOIN public.inbound_scans s ON s.id = a.set_scan_id
            WHERE a.bundle_id = b.id AND a.status = 'NORMAL' AND s.remaining_weight > 0
        ),
        b.created_at
    FROM public.product_bundles b
    JOIN public.products p ON p.id = b.product_id
    WHERE b.wholesaler_id = public.resolve_current_wholesaler_id()
    ORDER BY b.bundle_code;
$$;

REVOKE EXECUTE ON FUNCTION public.list_product_bundles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_product_bundles() TO authenticated;


CREATE OR REPLACE FUNCTION public.list_bundle_assemblies(
    p_bundle_id UUID    DEFAULT NULL,
    p_limit     INTEGER DEFAULT 100
)
RETURNS TABLE (
    assembly_id   UUID,
    bundle_id     UUID,
    bundle_code   TEXT,
    set_no        TEXT,
    product_name  TEXT,
    total_weight  NUMERIC,
    best_before   DATE,
    status        TEXT,
    remaining     NUMERIC,
    source_count  INTEGER,
    source_traces JSONB,
    assembled_by  TEXT,
    created_at    TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        a.id,
        a.bundle_id,
        b.bundle_code,
        a.set_no,
        p.name,
        a.total_weight,
        a.best_before,
        a.status,
        s.remaining_weight,
        (SELECT COUNT(*)::INTEGER FROM public.bundle_assembly_sources x WHERE x.assembly_id = a.id),
        COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'trace_no',     src.trace_no,
                       'product_name', cp.name,
                       'weight',       src.weight,
                       'grade',        m.grade,
                       'slaughter_date', m.slaughter_date
                   ) ORDER BY cp.name, src.trace_no)
            FROM public.bundle_assembly_sources src
            JOIN public.products cp ON cp.id = src.component_product_id
            LEFT JOIN public.master_livestock m ON m.trace_no = src.trace_no
            WHERE src.assembly_id = a.id
        ), '[]'::jsonb),
        pr.name,
        a.created_at
    FROM public.bundle_assemblies a
    JOIN public.product_bundles b ON b.id = a.bundle_id
    JOIN public.products p        ON p.id = b.product_id
    JOIN public.inbound_scans s   ON s.id = a.set_scan_id
    LEFT JOIN public.profiles pr  ON pr.id = a.assembled_by
    WHERE a.wholesaler_id = public.resolve_current_wholesaler_id()
      AND (p_bundle_id IS NULL OR a.bundle_id = p_bundle_id)
    ORDER BY a.created_at DESC
    LIMIT LEAST(COALESCE(p_limit, 100), 500);
$$;

REVOKE EXECUTE ON FUNCTION public.list_bundle_assemblies(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_bundle_assemblies(UUID, INTEGER) TO authenticated;


-- 이력번호 → 어느 세트에 들어갔고 그 세트가 어디로 나갔나.
-- 정부 추적이 들어왔을 때 내미는 답이다.
CREATE OR REPLACE FUNCTION public.trace_bundle_usage(p_trace_no TEXT)
RETURNS TABLE (
    trace_no          TEXT,
    set_no            TEXT,
    set_product_name  TEXT,
    component_name    TEXT,
    used_weight       NUMERIC,
    assembly_status   TEXT,
    assembled_at      TIMESTAMPTZ,
    order_number      TEXT,
    retailer_name     TEXT,
    shipped_at        TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        src.trace_no,
        a.set_no,
        p.name,
        cp.name,
        src.weight,
        a.status,
        a.created_at,
        shipped.order_number,
        shipped.retailer_name,
        shipped.shipped_at
    FROM public.bundle_assembly_sources src
    JOIN public.bundle_assemblies a ON a.id = src.assembly_id
    JOIN public.product_bundles b   ON b.id = a.bundle_id
    JOIN public.products p          ON p.id = b.product_id
    JOIN public.products cp         ON cp.id = src.component_product_id
    LEFT JOIN LATERAL (
        SELECT o.order_number, r.restaurant_name AS retailer_name, l.created_at AS shipped_at
        FROM public.stock_ledger l
        JOIN public.orders o    ON o.id = l.source_id
        JOIN public.retailers r ON r.id = o.retailer_id
        WHERE l.inbound_scan_id = a.set_scan_id
          AND l.source_type = 'order'
          AND l.event_type IN ('ORDER_OUT', 'OUTBOUND_ASSIGN')
          AND l.qty_delta < 0
        ORDER BY l.created_at DESC
        LIMIT 1
    ) shipped ON true
    WHERE a.wholesaler_id = public.resolve_current_wholesaler_id()
      AND src.trace_no ILIKE '%' || btrim(COALESCE(p_trace_no, '')) || '%'
      AND btrim(COALESCE(p_trace_no, '')) <> ''
    ORDER BY a.created_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.trace_bundle_usage(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trace_bundle_usage(TEXT) TO authenticated;


-- --------------------------------------------------------------------
-- 11. 명세서·라벨 — 세트 박스는 구성 이력번호로 전개한다.
--     세트 박스의 trace_no는 자체 세트번호라 master_livestock에 없다.
--     펼치지 않으면 명세서에 이력번호가 사라져 이력제 표시 의무를 못 지킨다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_trace_numbers(p_order_id UUID)
RETURNS TABLE (
    product_id     UUID,
    product_name   TEXT,
    trace_no       TEXT,
    quantity       NUMERIC,
    grade          TEXT,
    slaughter_date DATE,
    butchery_place TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH shipped AS (
        SELECT l.product_id, l.inbound_scan_id, -l.qty_delta AS qty
        FROM public.stock_ledger l
        JOIN public.orders o ON o.id = l.source_id
        WHERE l.source_type = 'order'
          AND l.source_id = p_order_id
          AND l.inbound_scan_id IS NOT NULL
          -- 출고 스캔이 있었으면 그것만, 없으면 자동 배정분을 쓴다.
          AND l.event_type = CASE
                WHEN EXISTS (
                    SELECT 1 FROM public.stock_ledger x
                    WHERE x.source_type = 'order' AND x.source_id = p_order_id
                      AND x.event_type = 'OUTBOUND_ASSIGN'
                ) THEN 'OUTBOUND_ASSIGN'
                ELSE 'ORDER_OUT'
              END
          AND (
                o.wholesaler_id = public.get_current_wholesaler_id()
             OR public.is_org_staff_of_wholesaler(o.wholesaler_id)
             OR o.retailer_id = public.get_current_retailer_id()
             OR public.get_current_role() = 'super_admin'
          )
    )
    SELECT
        s.product_id,
        p.name,
        sc.trace_no,
        s.qty,
        m.grade,
        m.slaughter_date,
        m.butchery_place
    FROM shipped s
    JOIN public.inbound_scans sc ON sc.id = s.inbound_scan_id
    JOIN public.products p       ON p.id = s.product_id
    LEFT JOIN public.master_livestock m ON m.trace_no = sc.trace_no
    WHERE NOT EXISTS (SELECT 1 FROM public.bundle_assemblies ba WHERE ba.set_scan_id = sc.id)

    UNION ALL

    SELECT
        s.product_id,
        p.name || ' › ' || cp.name,
        src.trace_no,
        ROUND(src.weight * (s.qty / NULLIF(sc.weight, 0)), 3),
        m.grade,
        m.slaughter_date,
        m.butchery_place
    FROM shipped s
    JOIN public.inbound_scans sc            ON sc.id = s.inbound_scan_id
    JOIN public.bundle_assemblies ba        ON ba.set_scan_id = sc.id
    JOIN public.bundle_assembly_sources src ON src.assembly_id = ba.id
    JOIN public.products p                  ON p.id = s.product_id
    JOIN public.products cp                 ON cp.id = src.component_product_id
    LEFT JOIN public.master_livestock m     ON m.trace_no = src.trace_no

    ORDER BY 2, 3;
$$;

REVOKE EXECUTE ON FUNCTION public.get_order_trace_numbers(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_order_trace_numbers(UUID) TO authenticated;


-- 라벨은 박스 한 개가 한 장이다. 세트 박스는 한 장에 구성 이력번호를 모두 찍는다
-- (박스를 열어보지 않고도 안에 무엇이 들었는지 라벨만으로 추적된다).
DROP FUNCTION IF EXISTS public.get_order_labels(UUID);

CREATE FUNCTION public.get_order_labels(p_order_id UUID)
RETURNS TABLE (
    product_name   TEXT,
    trace_no       TEXT,
    quantity       NUMERIC,
    unit           TEXT,
    grade          TEXT,
    origin         TEXT,
    slaughter_date DATE,
    packing_date   DATE,
    butchery_place TEXT,
    supplier_name  TEXT,
    order_number   TEXT,
    retailer_name  TEXT,
    is_bundle      BOOLEAN,
    total_weight   NUMERIC,
    best_before    DATE,
    source_traces  JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        p.name,
        s.trace_no,
        -l.qty_delta,
        COALESCE(s.unit, p.unit),
        COALESCE(m.grade, p.grade),
        p.origin,
        m.slaughter_date,
        m.packing_date,
        m.butchery_place,
        w.business_name,
        o.order_number,
        r.restaurant_name,
        ba.id IS NOT NULL,
        ba.total_weight,
        s.best_before,
        COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'trace_no',       src.trace_no,
                       'product_name',   cp.name,
                       'weight',         src.weight,
                       'grade',          sm.grade,
                       'slaughter_date', sm.slaughter_date,
                       'butchery_place', sm.butchery_place
                   ) ORDER BY cp.name, src.trace_no)
            FROM public.bundle_assembly_sources src
            JOIN public.products cp ON cp.id = src.component_product_id
            LEFT JOIN public.master_livestock sm ON sm.trace_no = src.trace_no
            WHERE src.assembly_id = ba.id
        ), '[]'::jsonb)
    FROM public.stock_ledger l
    JOIN public.orders o          ON o.id = l.source_id
    JOIN public.wholesalers w     ON w.id = o.wholesaler_id
    JOIN public.retailers r       ON r.id = o.retailer_id
    JOIN public.inbound_scans s   ON s.id = l.inbound_scan_id
    JOIN public.products p        ON p.id = l.product_id
    LEFT JOIN public.master_livestock m  ON m.trace_no = s.trace_no
    LEFT JOIN public.bundle_assemblies ba ON ba.set_scan_id = s.id
    WHERE l.source_type = 'order'
      AND l.source_id = p_order_id
      AND l.inbound_scan_id IS NOT NULL
      AND l.event_type = CASE
            WHEN EXISTS (
                SELECT 1 FROM public.stock_ledger x
                WHERE x.source_type = 'order' AND x.source_id = p_order_id
                  AND x.event_type = 'OUTBOUND_ASSIGN'
            ) THEN 'OUTBOUND_ASSIGN'
            ELSE 'ORDER_OUT'
          END
      AND (
            o.wholesaler_id = public.get_current_wholesaler_id()
         OR public.is_org_staff_of_wholesaler(o.wholesaler_id)
         OR public.get_current_role() = 'super_admin'
      )
    ORDER BY p.name, s.trace_no;
$$;

REVOKE EXECUTE ON FUNCTION public.get_order_labels(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_order_labels(UUID) TO authenticated;


-- 세트 박스 자체의 라벨 (출고 전, 창고에서 박스에 붙인다)
CREATE OR REPLACE FUNCTION public.get_bundle_labels(p_assembly_ids UUID[])
RETURNS TABLE (
    assembly_id    UUID,
    set_no         TEXT,
    product_name   TEXT,
    bundle_code    TEXT,
    origin         TEXT,
    total_weight   NUMERIC,
    best_before    DATE,
    supplier_name  TEXT,
    assembled_at   TIMESTAMPTZ,
    source_traces  JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        a.id,
        a.set_no,
        p.name,
        b.bundle_code,
        p.origin,
        a.total_weight,
        a.best_before,
        w.business_name,
        a.created_at,
        COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'trace_no',       src.trace_no,
                       'product_name',   cp.name,
                       'weight',         src.weight,
                       'grade',          m.grade,
                       'slaughter_date', m.slaughter_date,
                       'butchery_place', m.butchery_place
                   ) ORDER BY cp.name, src.trace_no)
            FROM public.bundle_assembly_sources src
            JOIN public.products cp ON cp.id = src.component_product_id
            LEFT JOIN public.master_livestock m ON m.trace_no = src.trace_no
            WHERE src.assembly_id = a.id
        ), '[]'::jsonb)
    FROM public.bundle_assemblies a
    JOIN public.product_bundles b ON b.id = a.bundle_id
    JOIN public.products p        ON p.id = b.product_id
    JOIN public.wholesalers w     ON w.id = a.wholesaler_id
    WHERE a.wholesaler_id = public.resolve_current_wholesaler_id()
      AND a.id = ANY(p_assembly_ids)
    ORDER BY a.set_no;
$$;

REVOKE EXECUTE ON FUNCTION public.get_bundle_labels(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_bundle_labels(UUID[]) TO authenticated;


-- 기간 요약에 세트 제작/해체를 빠뜨리면 합계가 안 맞는다 (15단계와 같은 함정).
-- 칸이 하나 늘어 반환 타입이 바뀌므로 CREATE OR REPLACE로는 안 되고 DROP이 먼저다.
DROP FUNCTION IF EXISTS public.summarize_stock_ledger(UUID, DATE, DATE, UUID, TEXT);

CREATE FUNCTION public.summarize_stock_ledger(
    p_wholesaler_id UUID,
    p_from          DATE DEFAULT NULL,
    p_to            DATE DEFAULT NULL,
    p_product_id    UUID DEFAULT NULL,
    p_trace_no      TEXT DEFAULT NULL
)
RETURNS TABLE (
    inbound_qty    NUMERIC,
    outbound_qty   NUMERIC,
    adjustment_qty NUMERIC,
    loss_qty       NUMERIC,
    bundle_qty     NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN ('INBOUND', 'INBOUND_VOID', 'OPENING_BALANCE')), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN (
            'ORDER_OUT', 'ORDER_RESTORE', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN'
        )), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'ADJUSTMENT'), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'LOSS'), 0),
        -- 세트 제작은 구성품(-)과 세트(+)가 단위가 달라(kg vs 세트) 합산에 의미가
        -- 없다. 그래서 별도 칸으로 빼고 "세트로 묶인 구성품 중량"만 센다.
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN ('BUNDLE_CONSUME', 'BUNDLE_RESTORE')), 0)
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
            p_wholesaler_id = public.get_current_wholesaler_id()
         OR public.is_org_staff_of_wholesaler(p_wholesaler_id)
         OR public.get_current_role() = 'super_admin'
      );
$$;

REVOKE EXECUTE ON FUNCTION public.summarize_stock_ledger(UUID, DATE, DATE, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summarize_stock_ledger(UUID, DATE, DATE, UUID, TEXT) TO authenticated;


-- --------------------------------------------------------------------
-- 12. 세트 상품의 단위는 '세트'로 고정한다.
--
-- 상품 수정 폼(updateProductAction)이 unit을 그대로 UPDATE하므로, 세트 상품을
-- 열어 저장만 해도 단위가 kg으로 바뀔 수 있다. 그러면 "세트 1개"로 세던 재고가
-- kg으로 읽히면서 45,000원짜리 세트가 0.7세트만큼 팔리는 상태가 된다.
-- 경로가 여럿이라(폼·일괄수정·관리자) 트리거로 막는다 — 출고 차감을 트리거로
-- 건 것과 같은 판단이다(1단계 설계 결정 10번).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.keep_bundle_product_unit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.unit IS DISTINCT FROM '세트'
       AND EXISTS (SELECT 1 FROM public.product_bundles WHERE product_id = NEW.id) THEN
        NEW.unit := '세트';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_keep_bundle_unit ON public.products;
CREATE TRIGGER trg_products_keep_bundle_unit
    BEFORE UPDATE OF unit ON public.products
    FOR EACH ROW EXECUTE FUNCTION public.keep_bundle_product_unit();
