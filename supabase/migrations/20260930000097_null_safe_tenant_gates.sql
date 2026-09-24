-- ====================================================================
-- 권한 게이트 NULL 비교 버그 일괄 수정 (보안 점검 결과, 2026-09-24)
--
-- 문제: SECURITY DEFINER RPC 여러 개가 "내 업체 것인가 / 관리자(owner·manager)
-- 인가"를 아래 두 패턴으로 검사했다.
--
--   (a) IF v_row.wholesaler_id <> v_wholesaler_id THEN RAISE ...
--   (b) IF v_wholesaler_id <> public.get_current_wholesaler_id()
--          AND NOT public.is_org_staff_of_wholesaler(v_wholesaler_id, owner/manager) THEN RAISE 'FORBIDDEN'
--
-- 둘 다 비교 대상이 NULL이면 결과가 NULL이 되고, plpgsql의 IF는 NULL을 거짓으로
-- 취급해 예외를 던지지 않는다(3치 논리). 실제로 NULL이 되는 경우가 흔하다:
--
--   * 고객(식당) 계정: resolve_current_wholesaler_id()가 NULL → (a) 통과.
--     미니샵·주문내역에 상품 ID가 노출되므로, 연결된 어느 공급사의 재고든
--     adjust_product_stock()으로 바꾸거나 set_product_archived()로 감출 수 있었다.
--   * 초대받은 직원(staff): get_current_wholesaler_id()는 원 가입자(owner)만
--     인식해 NULL → (b) 통과. owner/manager 전용이어야 할 매입단가·판매가
--     일괄수정·재고조정·보관·네고 단가 확정을 staff가 RPC 직접 호출로 할 수 있었다.
--     (화면은 requireOrgRole로 막지만 anon 키는 공개라 RPC 호출은 못 막는다.)
--
-- 수정 원칙:
--   1. NULL이면 항상 거부하는 헬퍼 두 개로 판정을 모은다.
--        can_access_wholesaler(p)  — "볼 수 있는가"  (owner / 소속 직원 전원 / super_admin)
--        can_manage_wholesaler(p)  — "고칠 수 있는가"(owner / manager / super_admin)
--      기존 can_access_wholesaler는 RLS/SQL WHERE에서만 쓰여 NULL이 곧 거부였지만,
--      plpgsql IF에서 쓰일 수 있도록 COALESCE로 NULL을 false로 닫는다.
--   2. 각 함수는 게이트 부분만 바꾸고 나머지 본문은 직전 정의를 그대로 둔다.
--   3. NULL 가드가 아예 없던 함수(update_inbound_purchase, delete_product_bundle,
--      disassemble_bundle_assembly)에는 다른 함수와 같은 NOT_A_SUPPLIER 가드를 넣는다.
--
-- super_admin: 앱의 requireOrgRole이 super_admin을 통과시키는 것과 맞춰
-- can_manage_wholesaler도 super_admin을 허용한다(감독 권한). 조직 미소속
-- super_admin은 어차피 화면에서 AdminScopeNotice로 막힌다.
--
-- 덤: 엑셀 대량 입고 이중 처리 방지용 유니크 인덱스(맨 아래 참고).
-- ====================================================================


-- --------------------------------------------------------------------
-- 0. 헬퍼
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_wholesaler(p_wholesaler_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(p_wholesaler_id = public.get_current_wholesaler_id(), false)
        OR public.is_org_staff_of_wholesaler(p_wholesaler_id)
        OR COALESCE(public.get_current_role() = 'super_admin', false);
$$;

CREATE OR REPLACE FUNCTION public.can_manage_wholesaler(p_wholesaler_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(p_wholesaler_id = public.get_current_wholesaler_id(), false)
        OR public.is_org_staff_of_wholesaler(
               p_wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[]
           )
        OR COALESCE(public.get_current_role() = 'super_admin', false);
$$;

COMMENT ON FUNCTION public.can_manage_wholesaler(UUID) IS
    '이 업체 데이터를 고칠 수 있는가 — owner 본인 / 조직 owner·manager / super_admin. NULL이면 항상 false(plpgsql IF에서 안전).';

REVOKE EXECUTE ON FUNCTION public.can_manage_wholesaler(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_wholesaler(UUID) TO authenticated;


-- --------------------------------------------------------------------
-- 1. adjust_product_stock — 본문은 20260930000068과 동일, 게이트만 교체
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_product_stock(
    p_product_id   UUID,
    p_new_quantity NUMERIC,
    p_reason_code  TEXT,
    p_reason_note  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_product       public.products%ROWTYPE;
    v_current       NUMERIC(10, 3);
    v_delta         NUMERIC(10, 3);
    v_event_type    TEXT;
    v_reason_label  TEXT;
BEGIN
    SELECT * INTO v_product FROM public.products WHERE id = p_product_id;

    -- 고객 계정·남의 업체 → 존재 여부조차 알려주지 않는다.
    IF v_product.id IS NULL OR NOT public.can_access_wholesaler(v_product.wholesaler_id) THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    -- 재고 조정은 관리 행위 — owner/manager만 (화면 PRODUCT_ROLES와 동일).
    IF NOT public.can_manage_wholesaler(v_product.wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    v_reason_label := CASE p_reason_code
        WHEN 'STOCKTAKE' THEN '재고 실사'
        WHEN 'DISPOSAL'  THEN '폐기'
        WHEN 'DAMAGE'    THEN '파손·손실'
        WHEN 'RETURN'    THEN '반품 입고'
        WHEN 'OTHER'     THEN '기타'
        ELSE NULL
    END;

    IF v_reason_label IS NULL THEN
        RAISE EXCEPTION 'INVALID_REASON';
    END IF;

    -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 기초재고로 먼저 옮긴다.
    PERFORM public.ensure_opening_balance(p_product_id);

    SELECT COALESCE(SUM(qty_delta), 0) INTO v_current
    FROM public.stock_ledger WHERE product_id = p_product_id;

    v_delta := p_new_quantity - v_current;

    IF v_delta = 0 THEN
        RETURN jsonb_build_object('changed', false, 'stock_quantity', v_current);
    END IF;

    -- 폐기/파손으로 줄어든 건 손실(LOSS)로 구분해 남긴다 — 나중에 손실률 집계에 쓴다.
    v_event_type := CASE
        WHEN v_delta < 0 AND p_reason_code IN ('DISPOSAL', 'DAMAGE') THEN 'LOSS'
        ELSE 'ADJUSTMENT'
    END;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) VALUES (
        v_product.wholesaler_id, p_product_id, NULL, v_delta,
        v_event_type, 'manual', NULL,
        v_reason_label || COALESCE(' — ' || NULLIF(btrim(p_reason_note), ''), ''),
        auth.uid()
    );

    PERFORM public.recalc_product_stock(p_product_id);

    RETURN jsonb_build_object(
        'changed', true,
        'delta', v_delta,
        'stock_quantity', p_new_quantity,
        'event_type', v_event_type
    );
END;
$$;


-- --------------------------------------------------------------------
-- 2. set_product_archived — 본문은 20260930000063과 동일, 게이트만 교체
-- --------------------------------------------------------------------
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
    v_product public.products%ROWTYPE;
BEGIN
    SELECT * INTO v_product FROM public.products WHERE id = p_product_id;

    IF v_product.id IS NULL OR NOT public.can_access_wholesaler(v_product.wholesaler_id) THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    IF NOT public.can_manage_wholesaler(v_product.wholesaler_id) THEN
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


-- --------------------------------------------------------------------
-- 3. update_inbound_purchase — 본문은 20260930000083과 동일, 게이트만 교체
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_inbound_purchase(
    p_scan_id             UUID,
    p_unit_price          NUMERIC,
    p_supplier_name       TEXT DEFAULT NULL,
    p_apply_default       BOOLEAN DEFAULT false,
    p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_scan          public.inbound_scans%ROWTYPE;
    v_updated_rows  INTEGER;
BEGIN
    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    IF v_scan.id IS NULL OR NOT public.can_access_wholesaler(v_scan.wholesaler_id) THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    -- 매입단가는 원가라 owner/manager만 고칠 수 있다 (set_product_purchase_price와 동일 게이트).
    IF NOT public.can_manage_wholesaler(v_scan.wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF p_unit_price IS NULL OR p_unit_price < 0 THEN
        RAISE EXCEPTION 'INVALID_UNIT_PRICE';
    END IF;

    UPDATE public.inbound_scans
    SET purchase_unit_price = p_unit_price,
        purchase_supplier   = COALESCE(NULLIF(btrim(COALESCE(p_supplier_name, '')), ''), purchase_supplier)
    WHERE id = p_scan_id
      AND (p_expected_updated_at IS NULL OR updated_at = p_expected_updated_at)
    RETURNING * INTO v_scan;

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

    IF v_updated_rows = 0 THEN
        -- 내가 읽은 뒤로 다른 사람이 먼저 저장했다 — 지금 값을 실어 되돌려준다.
        SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

        RAISE EXCEPTION 'PRICE_CONFLICT:%:%',
            COALESCE(v_scan.purchase_unit_price::TEXT, ''),
            to_char(v_scan.updated_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI');
    END IF;

    -- "앞으로 이 단가를 기본으로" — 같은 상품을 다음에 찍을 때 자동으로 붙는다.
    -- 20260930000083 본문은 wholesaler_id(NOT NULL)를 빼고 INSERT해서, 그 상품의
    -- 기본단가 행이 아직 없으면 NOT NULL 위반으로 저장 전체가 실패했다
    -- (scripts/db-test-inbound-purchase.sql W9가 이 회귀를 잡았다). 여기서 함께 고친다.
    IF p_apply_default AND v_scan.product_id IS NOT NULL THEN
        INSERT INTO public.product_purchase_prices (
            wholesaler_id, product_id, unit_price, supplier_name, updated_by
        ) VALUES (
            v_scan.wholesaler_id, v_scan.product_id, p_unit_price, v_scan.purchase_supplier, auth.uid()
        )
        ON CONFLICT (product_id) DO UPDATE
        SET unit_price    = EXCLUDED.unit_price,
            supplier_name = EXCLUDED.supplier_name,
            updated_by    = EXCLUDED.updated_by;
    END IF;

    RETURN jsonb_build_object(
        'scan_id',           v_scan.id,
        'purchase_unit_price', v_scan.purchase_unit_price,
        'purchase_amount',    v_scan.purchase_amount,
        'purchase_supplier',  v_scan.purchase_supplier,
        'updated_at',         v_scan.updated_at
    );
END;
$$;


-- --------------------------------------------------------------------
-- 4. set_product_purchase_price — 본문은 20260930000072와 동일, 게이트만 교체
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_product_purchase_price(
    p_product_id    UUID,
    p_unit_price    NUMERIC,
    p_supplier_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    -- 매입단가는 원가라 owner/manager만 (화면 PURCHASE_ROLES와 동일).
    IF NOT public.can_manage_wholesaler(v_wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    PERFORM 1 FROM public.products
    WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    IF p_unit_price IS NULL OR p_unit_price < 0 THEN
        RAISE EXCEPTION 'INVALID_UNIT_PRICE';
    END IF;

    INSERT INTO public.product_purchase_prices (
        wholesaler_id, product_id, unit_price, supplier_name, updated_by
    ) VALUES (
        v_wholesaler_id, p_product_id, p_unit_price,
        NULLIF(btrim(COALESCE(p_supplier_name, '')), ''), auth.uid()
    )
    ON CONFLICT (product_id) DO UPDATE SET
        unit_price    = EXCLUDED.unit_price,
        supplier_name = EXCLUDED.supplier_name,
        updated_by    = EXCLUDED.updated_by;

    RETURN jsonb_build_object('product_id', p_product_id, 'unit_price', p_unit_price);
END;
$$;


-- --------------------------------------------------------------------
-- 5. bulk_update_product_prices — 본문은 20260930000064와 동일, 게이트만 교체
-- --------------------------------------------------------------------
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

    -- 판매가 일괄수정은 관리 행위 — owner/manager만.
    IF NOT public.can_manage_wholesaler(v_wholesaler_id) THEN
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


-- --------------------------------------------------------------------
-- 6. update_order_item_price — 본문은 20260930000085와 동일, 게이트만 교체
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_order_item_price(
    p_order_item_id UUID,
    p_unit_price    NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_item          public.order_items%ROWTYPE;
    v_order         public.orders%ROWTYPE;
    v_total         NUMERIC(12, 2);
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_item FROM public.order_items WHERE id = p_order_item_id;

    IF v_item.id IS NULL THEN
        RAISE EXCEPTION 'ITEM_NOT_FOUND';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = v_item.order_id FOR UPDATE;

    IF v_order.id IS NULL OR v_order.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'ITEM_NOT_FOUND';
    END IF;

    -- 매출 단가 확정도 매입단가와 동일 게이트(owner/manager만).
    IF NOT public.can_manage_wholesaler(v_wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    -- 출고 마감 이후, 또는 이미 배송중/완료/취소로 끝난 발주는 금액이 굳어있다.
    -- 흥정은 접수~확정 사이에 끝나야 하는 절차다.
    IF v_order.shipment_finalized_at IS NOT NULL
       OR v_order.status NOT IN ('pending', 'awaiting_stock', 'confirmed') THEN
        RAISE EXCEPTION 'ORDER_LOCKED';
    END IF;

    IF p_unit_price IS NULL OR p_unit_price < 0 THEN
        RAISE EXCEPTION 'INVALID_UNIT_PRICE';
    END IF;

    UPDATE public.order_items
    SET unit_price      = p_unit_price,
        subtotal_amount = ROUND(p_unit_price * quantity, 2)
    WHERE id = p_order_item_id;

    SELECT COALESCE(SUM(subtotal_amount), 0) INTO v_total
    FROM public.order_items
    WHERE order_id = v_order.id;

    UPDATE public.orders
    SET total_amount = v_total,
        updated_at   = now()
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
        'order_item_id',      p_order_item_id,
        'unit_price',         p_unit_price,
        'subtotal_amount',    ROUND(p_unit_price * v_item.quantity, 2),
        'order_total_amount', v_total
    );
END;
$$;


-- --------------------------------------------------------------------
-- 7. delete_product_bundle — 본문은 20260930000071과 동일, NOT_A_SUPPLIER 가드 추가
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

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

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


-- --------------------------------------------------------------------
-- 8. disassemble_bundle_assembly — 본문은 20260930000071과 동일, NOT_A_SUPPLIER 가드 추가
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

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

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


-- --------------------------------------------------------------------
-- 9. 엑셀 대량 입고 이중 처리 방지
--
-- processImportChunkAction(app/dashboard/inbound/actions.ts)은 대기 행을 선점
-- 없이 읽어 처리한다. 탭을 두 개 열거나 새로고침 자동재개가 겹치면 같은 행이
-- 두 번 record_inbound_scan을 타고, EXCEL 경로는 중복 의심 검사도 건너뛰어
-- 재고가 두 배로 잡혔다. 스캔 행에 어느 업로드 행에서 왔는지(import_row_id)를
-- 남기고 유니크로 걸어, 두 번째 시도는 DB가 거부하게 한다. 서버 액션은 이
-- 위반을 "이미 다른 창에서 처리됨"으로 해석해 행 상태를 건드리지 않는다.
-- --------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_scans_import_row_unique
    ON public.inbound_scans (import_row_id)
    WHERE import_row_id IS NOT NULL;
