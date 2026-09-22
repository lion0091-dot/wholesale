-- ====================================================================
-- 자동 생성 상품 운영에서 드러난 구멍 4개 수정
--
-- (1) 원장이 걸린 상품은 삭제할 수 없다
--     stock_ledger.product_id가 ON DELETE RESTRICT라(입출고 기록은 지우면 안 되는
--     자료다) 한 번이라도 입출고가 있던 상품은 DELETE가 실패한다. 오스캔으로
--     엉뚱한 상품이 하나 생기면 목록에서 영영 못 치운다.
--     → 삭제 대신 보관(archived_at)으로 치운다. 기록은 남고 목록에서는 사라진다.
--
-- (2)(3) 자동 생성으로 상품이 늘고 판매가 미설정 상품이 섞인다
--     실제로는 취급하는 조합만 생기므로 폭증하지는 않지만, 초기에 0원 상품이
--     몰려 진짜 파는 상품을 찾기 어려워진다.
--     → 보관 상태를 만들어 목록에서 걸러낼 수 있게 하고, 화면에 상태 필터를 둔다.
--
-- (4) 자동 생성 상품이 '판매중'이라 가격만 넣으면 즉시 팔린다
--     아직 팔 준비가 안 됐는데 주문이 들어올 수 있다.
--     → 자동 생성은 '판매중지'로 만든다. 공급사가 가격을 넣고 직접 켜야 노출된다.
-- ====================================================================

-- (1) ------------------------------------------------------------------
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.products.archived_at IS
    '보관 처리 시각. 입출고 기록이 있는 상품은 삭제할 수 없어(원장 FK RESTRICT) 대신 보관한다. 보관된 상품은 목록과 고객 카탈로그에서 제외된다.';

CREATE INDEX IF NOT EXISTS idx_products_active_not_archived
    ON public.products (wholesaler_id)
    WHERE archived_at IS NULL;

-- 고객에게는 보관된 상품을 내보내지 않는다.
DROP POLICY IF EXISTS "Products viewable by owner, org staff, priced for retailers, or admin" ON public.products;

CREATE POLICY "Products viewable by owner, org staff, priced unarchived for retailers, or admin" ON public.products
    FOR SELECT USING (
        public.can_access_wholesaler(wholesaler_id)
        OR (
            is_active = true
            AND base_price > 0
            AND archived_at IS NULL
            AND wholesaler_id IN (
                SELECT wholesaler_id FROM public.wholesaler_retailers
                WHERE retailer_id = public.get_current_retailer_id() AND status = 'active'
            )
        )
    );


-- 보관/복원. 보관 시 판매도 함께 내린다 — 목록에서 감췄는데 미니샵에 남아 있으면 사고다.
CREATE OR REPLACE FUNCTION public.set_product_archived(
    p_product_id UUID,
    p_archived   BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_product       public.products%ROWTYPE;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    SELECT * INTO v_product FROM public.products WHERE id = p_product_id;

    IF v_product.id IS NULL
       OR (v_product.wholesaler_id <> v_wholesaler_id AND public.get_current_role() <> 'super_admin') THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    -- resolve_current_wholesaler_id()는 owner/manager/staff 구분 없이 통과시키므로,
    -- 화면(상품관리)과 같은 owner/manager 전용 게이트를 여기서도 건다.
    IF v_wholesaler_id <> public.get_current_wholesaler_id()
       AND NOT public.is_org_staff_of_wholesaler(v_wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[])
       AND public.get_current_role() <> 'super_admin' THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    UPDATE public.products
    SET archived_at = CASE WHEN p_archived THEN now() ELSE NULL END,
        is_active = CASE WHEN p_archived THEN false ELSE is_active END,
        updated_at = now()
    WHERE id = p_product_id;

    RETURN jsonb_build_object('product_id', p_product_id, 'archived', p_archived);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_product_archived(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_product_archived(UUID, BOOLEAN) TO authenticated;


-- 이 상품에 입출고 기록이 있는지 — 화면이 "삭제" 대신 "보관"을 안내할 때 쓴다.
CREATE OR REPLACE FUNCTION public.product_has_stock_history(p_product_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.stock_ledger WHERE product_id = p_product_id);
$$;

REVOKE EXECUTE ON FUNCTION public.product_has_stock_history(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.product_has_stock_history(UUID) TO authenticated;


-- (4) ------------------------------------------------------------------
-- 자동 생성 상품은 '판매중지'로 만든다. 공급사가 가격을 넣고 직접 켜야 노출된다.
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

    IF v_master.species_group IS NULL OR v_master.part_name IS NULL THEN
        RETURN jsonb_build_object('created', false, 'reason', 'INSUFFICIENT_TRACE_INFO');
    END IF;

    -- 보관된 상품도 재사용 대상에 넣는다 — 같은 조합을 다시 찍었으면 새로 만드는 것보다
    -- 보관을 풀어 쓰는 게 맞다.
    SELECT id INTO v_product_id
    FROM public.products
    WHERE wholesaler_id = v_wholesaler_id
      AND category = v_master.species_group
      AND subcategory = v_master.part_name
      AND COALESCE(grade, '') = COALESCE(v_master.grade, '')
    ORDER BY archived_at NULLS FIRST
    LIMIT 1;

    IF v_product_id IS NULL THEN
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
            0, COALESCE(NULLIF(v_scan.unit, ''), 'kg'), 0,
            -- 판매중지로 만든다 (설계 결정 4번). 가격만 넣으면 바로 팔리는 상황을 막는다.
            false,
            '입고 스캔으로 자동 등록됨 (이력번호 ' || v_scan.trace_no || ')',
            auth.uid()
        )
        RETURNING id INTO v_product_id;

        v_created := true;

    ELSE
        -- 보관돼 있던 상품을 다시 쓰는 경우 보관만 푼다(판매 여부는 공급사가 정한다).
        UPDATE public.products
        SET archived_at = NULL, updated_at = now()
        WHERE id = v_product_id AND archived_at IS NOT NULL;
    END IF;

    PERFORM public.resolve_inbound_mapping(p_scan_id, v_product_id, true);

    RETURN jsonb_build_object(
        'created', v_created,
        'product_id', v_product_id,
        'product_name', (SELECT name FROM public.products WHERE id = v_product_id),
        'needs_price', (SELECT base_price = 0 FROM public.products WHERE id = v_product_id),
        'needs_activation', (SELECT NOT is_active FROM public.products WHERE id = v_product_id)
    );
END;
$$;
