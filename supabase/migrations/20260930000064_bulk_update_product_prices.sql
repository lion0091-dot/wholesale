-- ====================================================================
-- 판매가 일괄 등록
--
-- 스캔으로 자동 등록된 상품은 판매가가 0원이라 고객에게 안 보인다. 수십 개를
-- 화면에서 하나씩 고치는 건 고통스러워서, 목록을 CSV로 내려받아 엑셀에서 값을
-- 채우고 다시 올리는 경로를 만든다.
--
-- 잠긴 설계 결정:
--
--  1. 상품 식별은 UUID로만 한다. 이름으로 맞추면 같은 이름이 둘이거나 엑셀에서
--     이름을 고친 순간 엉뚱한 상품 가격이 바뀐다. CSV에 ID 칸을 넣고 건드리지
--     말라고 안내한다.
--
--  2. 빈 칸이나 0은 "입력 안 함"으로 보고 건너뛴다. 실수로 지운 칸 때문에
--     멀쩡한 가격이 0이 되면 그 상품이 고객에게서 사라진다.
--
--  3. 판매중 전환은 선택이다(p_activate). 가격만 넣고 아직 팔지 않을 수도 있다.
--     전환하더라도 가격이 들어간 상품만 켠다.
-- ====================================================================
CREATE OR REPLACE FUNCTION public.bulk_update_product_prices(
    p_updates  JSONB,
    p_activate BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_item          JSONB;
    v_product_id    UUID;
    v_price         NUMERIC;
    v_updated       INTEGER := 0;
    v_skipped       INTEGER := 0;
    v_not_found     INTEGER := 0;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    -- resolve_current_wholesaler_id()는 owner/manager/staff 구분 없이 통과시키므로,
    -- 화면(상품관리)과 같은 owner/manager 전용 게이트를 여기서도 건다.
    IF v_wholesaler_id <> public.get_current_wholesaler_id()
       AND NOT public.is_org_staff_of_wholesaler(v_wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[]) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF jsonb_typeof(p_updates) <> 'array' THEN
        RAISE EXCEPTION 'INVALID_PAYLOAD';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_updates)
    LOOP
        BEGIN
            v_product_id := (v_item ->> 'id')::uuid;
        EXCEPTION WHEN others THEN
            -- ID 칸이 망가진 줄은 건너뛴다 (엑셀에서 잘못 편집한 경우).
            v_not_found := v_not_found + 1;
            CONTINUE;
        END;

        v_price := NULLIF(v_item ->> 'price', '')::numeric;

        -- 빈 칸·0·음수는 "입력 안 함"으로 본다 (설계 결정 2번).
        IF v_price IS NULL OR v_price <= 0 THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        UPDATE public.products
        SET base_price = v_price,
            is_active = CASE WHEN p_activate THEN true ELSE is_active END,
            updated_at = now(),
            updated_by = auth.uid()
        WHERE id = v_product_id
          AND wholesaler_id = v_wholesaler_id
          AND archived_at IS NULL;

        IF FOUND THEN
            v_updated := v_updated + 1;
        ELSE
            v_not_found := v_not_found + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'updated', v_updated,
        'skipped', v_skipped,
        'not_found', v_not_found
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.bulk_update_product_prices(JSONB, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_update_product_prices(JSONB, BOOLEAN) TO authenticated;
