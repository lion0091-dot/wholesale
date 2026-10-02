-- 회계 관리 메뉴 + 탭별 켜기/끄기 (2026-10-02)
--
-- ■ 쉬운 설명
--   기능 메뉴판(platform_features)에 "부모 기능" 칸(parent_key)을 추가한다.
--   "회계 관리"(accounting)가 메뉴 전체, 그 아래 탭(미수금 정산·매입 정산·원가 관리·장부 불일치)이 자식 기능이다.
--   · 메뉴(부모)를 끄면 탭(자식)은 저절로 함께 꺼진다. 메뉴가 켜져 있으면 탭은 하나씩 켜고 끌 수 있다.
--   · feature_enabled()는 그대로 "그 기능 자체의 켜짐 값"이다(켜진 기간 이력 불변식 210이 이 값을 기준으로 하기 때문).
--     부모까지 반영한 "실제로 쓸 수 있나"는 새 함수 feature_effective()가 답한다. 화면·DB 함수의 접근 검사는 이것을 쓴다.
--   · 탭 키(accounting_*)는 "켜짐/꺼짐"만 가른다. 누가 보나는 기존 역할 규칙(대표 전용·원가 열람 범위 등)이 그대로 정한다.
--     (원가 관리 cost_management만 기존처럼 대표가 허용한 사람 목록을 쓴다.)
--   · 모든 키는 기본 켜짐 — 지금 쓰는 업체의 동작은 바뀌지 않는다.
--   · 부모는 한 단계까지만(부모의 부모는 없다).

-- ============================================================
-- 1. 부모 칸 + 실제 사용 가능 판정
-- ============================================================
ALTER TABLE public.platform_features
    ADD COLUMN IF NOT EXISTS parent_key text REFERENCES public.platform_features(key) ON DELETE SET NULL;

ALTER TABLE public.platform_features DROP CONSTRAINT IF EXISTS platform_features_parent_not_self;
ALTER TABLE public.platform_features
    ADD CONSTRAINT platform_features_parent_not_self CHECK (parent_key IS NULL OR parent_key <> key);

-- 이 업체에서 이 기능을 실제로 쓸 수 있나: 기능 자체가 켜져 있고, 부모가 있으면 부모도 켜져 있어야 한다.
CREATE OR REPLACE FUNCTION public.feature_effective(p_wholesaler_id uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT public.feature_enabled(p_wholesaler_id, p_key)
       AND COALESCE(
            (SELECT public.feature_enabled(p_wholesaler_id, p.parent_key)
               FROM public.platform_features p
              WHERE p.key = p_key AND p.parent_key IS NOT NULL),
            true
       );
$$;

REVOKE ALL ON FUNCTION public.feature_effective(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feature_effective(uuid, text) TO authenticated, service_role;

-- 접근 검사 4곳을 부모까지 반영하도록 바꾼다(본문은 210 그대로, 판정 함수만 feature_effective).
CREATE OR REPLACE FUNCTION public.can_use_feature(p_wholesaler_id uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT COALESCE(
        public.feature_effective(p_wholesaler_id, p_key)
        AND (
            public.is_wholesaler_owner(p_wholesaler_id)
            OR EXISTS (
                SELECT 1 FROM public.wholesaler_feature_viewers v
                 WHERE v.wholesaler_id = p_wholesaler_id AND v.feature_key = p_key AND v.user_id = auth.uid()
            )
        ),
        false
    );
$$;

CREATE OR REPLACE FUNCTION public.set_feature_viewer(p_key text, p_user_id uuid, p_allowed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF NOT public.feature_effective(v_wid, p_key) THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    IF p_allowed THEN
        -- 같은 업체의 매니저·직원만 허용할 수 있다(대표는 항상 쓰고, 다른 업체 사람은 안 된다).
        IF NOT EXISTS (
            SELECT 1
            FROM public.organization_staff s
            JOIN public.organizations o ON o.id = s.organization_id
            WHERE o.wholesaler_id = v_wid AND s.user_id = p_user_id AND s.role IN ('manager', 'staff')
        ) THEN
            RAISE EXCEPTION 'NOT_A_MEMBER';
        END IF;

        INSERT INTO public.wholesaler_feature_viewers (wholesaler_id, feature_key, user_id, granted_by)
        VALUES (v_wid, p_key, p_user_id, auth.uid())
        ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM public.wholesaler_feature_viewers
         WHERE wholesaler_id = v_wid AND feature_key = p_key AND user_id = p_user_id;
    END IF;
END;
$$;

-- 지금 로그인한 업체에서 "실제로 쓸 수 있는" 기능(부모가 꺼진 자식 제외). 메뉴·탭을 가리는 화면이 쓴다.
CREATE OR REPLACE FUNCTION public.current_wholesaler_features()
RETURNS TABLE (feature_key text, config jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    WITH me AS MATERIALIZED (SELECT public.resolve_current_wholesaler_id() AS wid)
    SELECT p.key, COALESCE(f.config, '{}'::jsonb)
    FROM me
    CROSS JOIN public.platform_features p
    LEFT JOIN public.wholesaler_features f ON f.feature_key = p.key AND f.wholesaler_id = me.wid
    WHERE me.wid IS NOT NULL
      AND public.feature_effective(me.wid, p.key);
$$;

DROP FUNCTION IF EXISTS public.admin_list_wholesaler_features();

-- 어드민 화면용: enabled = 그 기능 자체의 값, parent_key/parent_enabled = 부모 정보(부모가 꺼져 있으면 화면이 "함께 꺼짐"으로 보여준다).
CREATE OR REPLACE FUNCTION public.admin_list_wholesaler_features()
RETURNS TABLE (
    wholesaler_id uuid, business_name text, feature_key text, feature_label text,
    enabled boolean, is_override boolean, config jsonb,
    parent_key text, parent_enabled boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
BEGIN
    IF COALESCE(public.get_current_role() = 'super_admin', false) IS NOT TRUE THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    RETURN QUERY
    SELECT w.id, w.business_name, p.key, p.label,
           COALESCE(f.enabled, p.default_enabled),
           f.feature_key IS NOT NULL,
           COALESCE(f.config, '{}'::jsonb),
           p.parent_key,
           CASE WHEN p.parent_key IS NULL THEN NULL ELSE public.feature_enabled(w.id, p.parent_key) END
    FROM public.wholesalers w
    CROSS JOIN public.platform_features p
    LEFT JOIN public.wholesaler_features f ON f.wholesaler_id = w.id AND f.feature_key = p.key
    ORDER BY w.business_name, COALESCE(p.parent_key, p.key), p.parent_key NULLS FIRST, p.key;
END;
$$;

REVOKE ALL ON FUNCTION public.can_use_feature(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_feature_viewer(text, uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_wholesaler_features() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_wholesaler_features() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_feature(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_feature_viewer(text, uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_wholesaler_features() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_wholesaler_features() TO authenticated, service_role;

-- ============================================================
-- 2. 기능 등록 — 모두 기본 켜짐
-- ============================================================
INSERT INTO public.platform_features (key, label, description, default_enabled, parent_key) VALUES
    ('accounting', '회계 관리',
     '미수금 정산·매입 정산·원가 관리·장부 불일치 등 회계 화면을 한 메뉴로 묶습니다. 끄면 아래 탭이 모두 함께 꺼집니다.',
     true, NULL)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.platform_features (key, label, description, default_enabled, parent_key) VALUES
    ('accounting_receivables', '회계 관리 · 미수금 정산', '외상 거래처의 미수금을 확인하고 수금 처리하는 탭입니다.', true, 'accounting'),
    ('accounting_purchases',   '회계 관리 · 매입 정산',   '입고 박스의 실중량 기준 매입금액을 정산하는 탭입니다.', true, 'accounting'),
    ('accounting_integrity',   '회계 관리 · 장부 불일치', '전산 재고 숫자가 입출고 기록과 다른 항목을 점검·보정하는 탭입니다(대표 전용).', true, 'accounting')
ON CONFLICT (key) DO NOTHING;

UPDATE public.platform_features SET parent_key = 'accounting' WHERE key = 'cost_management';

SELECT public.open_default_feature_periods('accounting');
SELECT public.open_default_feature_periods('accounting_receivables');
SELECT public.open_default_feature_periods('accounting_purchases');
SELECT public.open_default_feature_periods('accounting_integrity');

-- ============================================================
-- 3. 탭의 DB 함수 맨 앞 검사 — 꺼진 업체(또는 메뉴가 꺼진 업체)에는 데이터를 주지 않는다.
--    본문은 로컬 DB의 pg_get_functiondef 결과 그대로이고, 검사 한 줄만 더했다.
--    (미수금 정산은 orders 표를 직접 읽고 모바일 "수금 확인"과 함수를 같이 써서 DB 함수 대신 화면·서버 액션에서 막는다.)
-- ============================================================

-- 3-1. 매입 정산(accounting_purchases)
CREATE OR REPLACE FUNCTION public.list_inbound_purchases(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_supplier text DEFAULT NULL::text, p_only_gap boolean DEFAULT false, p_limit integer DEFAULT 200)
 RETURNS TABLE(scan_id uuid, scanned_at timestamp with time zone, trace_no text, product_id uuid, product_name text, labeled_weight numeric, actual_weight numeric, weight_variance numeric, variance_ratio numeric, unit_price numeric, purchase_amount numeric, purchase_supplier text, status text, scanned_by text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        s.id,
        s.created_at,
        s.trace_no,
        s.product_id,
        p.name,
        s.labeled_weight,
        s.weight,
        s.weight_variance,
        CASE
            WHEN s.labeled_weight IS NULL OR s.labeled_weight = 0 THEN NULL
            ELSE ROUND(s.weight_variance / s.labeled_weight, 4)
        END,
        s.purchase_unit_price,
        s.purchase_amount,
        s.purchase_supplier,
        s.status,
        pr.name,
        s.updated_at
    FROM public.inbound_scans s
    LEFT JOIN public.products p  ON p.id = s.product_id
    LEFT JOIN public.profiles pr ON pr.id = s.scanned_by
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
      AND (SELECT public.can_view_cost(public.resolve_current_wholesaler_id()))
      AND public.feature_effective(public.resolve_current_wholesaler_id(), 'accounting_purchases')
      AND s.status <> 'VOIDED'
      AND (p_from IS NULL OR s.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR s.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR s.product_id = p_product_id)
      AND (
            NULLIF(btrim(COALESCE(p_supplier, '')), '') IS NULL
         OR s.purchase_supplier ILIKE '%' || btrim(p_supplier) || '%'
      )
      AND (
            NOT p_only_gap
         OR (
              s.labeled_weight IS NOT NULL
              AND s.labeled_weight > 0
              AND abs(s.weight_variance / s.labeled_weight) > public.inbound_weight_tolerance()
            )
      )
    ORDER BY s.created_at DESC
    LIMIT LEAST(COALESCE(p_limit, 200), 1000);
$function$;

CREATE OR REPLACE FUNCTION public.summarize_inbound_purchases(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_supplier text DEFAULT NULL::text)
 RETURNS TABLE(box_count integer, labeled_total numeric, actual_total numeric, variance_total numeric, purchase_total numeric, unpriced_count integer, over_gap_count integer, variance_amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        COUNT(*)::INTEGER,
        COALESCE(SUM(s.labeled_weight), 0),
        COALESCE(SUM(s.weight), 0),
        COALESCE(SUM(s.weight_variance), 0),
        COALESCE(SUM(s.purchase_amount), 0),
        COUNT(*) FILTER (WHERE s.purchase_unit_price IS NULL)::INTEGER,
        COUNT(*) FILTER (
            WHERE s.labeled_weight IS NOT NULL AND s.labeled_weight > 0
              AND abs(s.weight_variance / s.labeled_weight) > public.inbound_weight_tolerance()
        )::INTEGER,
        COALESCE(SUM(ROUND(s.weight_variance * s.purchase_unit_price, 0)), 0)
    FROM public.inbound_scans s
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
      AND (SELECT public.can_view_cost(public.resolve_current_wholesaler_id()))
      AND public.feature_effective(public.resolve_current_wholesaler_id(), 'accounting_purchases')
      AND s.status <> 'VOIDED'
      AND (p_from IS NULL OR s.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR s.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR s.product_id = p_product_id)
      AND (
            NULLIF(btrim(COALESCE(p_supplier, '')), '') IS NULL
         OR s.purchase_supplier ILIKE '%' || btrim(p_supplier) || '%'
      );
$function$;

CREATE OR REPLACE FUNCTION public.update_inbound_purchase(p_scan_id uuid, p_unit_price numeric, p_supplier_name text DEFAULT NULL::text, p_apply_default boolean DEFAULT false, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_scan          public.inbound_scans%ROWTYPE;
    v_updated_rows  INTEGER;
BEGIN
    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    IF v_scan.id IS NULL OR NOT public.can_access_wholesaler(v_scan.wholesaler_id) THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    -- 매입단가는 원가라 대표·전표 담당 직원만 고칠 수 있다 (set_product_purchase_price와 동일 게이트, 209).
    IF NOT public.can_view_cost(v_scan.wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    -- 회계 관리 > 매입 정산 탭이 꺼진 업체(또는 회계 관리 메뉴가 꺼진 업체)는 이 화면으로 단가를 고칠 수 없다(217).
    IF NOT public.feature_effective(v_scan.wholesaler_id, 'accounting_purchases') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
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
$function$;

-- 3-2. 장부 불일치(accounting_integrity)
CREATE OR REPLACE FUNCTION public.list_stock_mismatches()
 RETURNS TABLE(kind text, target_id uuid, label text, unit text, current_value numeric, ledger_value numeric, diff numeric, box_weight numeric, unit_price numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    IF NOT public.feature_effective(v_wid, 'accounting_integrity') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    RETURN QUERY
    (
        SELECT 'product'::text, p.id, p.name::text, COALESCE(p.unit, 'kg')::text,
               p.stock_quantity, lp.total, p.stock_quantity - lp.total, NULL::numeric, NULL::numeric
        FROM public.products p
        JOIN (
            SELECT l.product_id, sum(l.qty_delta) AS total
            FROM public.stock_ledger l WHERE l.wholesaler_id = v_wid GROUP BY l.product_id
        ) lp ON lp.product_id = p.id
        WHERE p.wholesaler_id = v_wid AND p.stock_quantity <> lp.total
        ORDER BY abs(p.stock_quantity - lp.total) DESC, p.name
        LIMIT 200
    )
    UNION ALL
    (
        SELECT 'box'::text, s.id, (s.trace_no || COALESCE(' · ' || p.name, ''))::text, COALESCE(p.unit, 'kg')::text,
               s.remaining_weight, lb.total, s.remaining_weight - lb.total, s.weight, s.purchase_unit_price
        FROM public.inbound_scans s
        JOIN (
            SELECT l.inbound_scan_id, sum(l.qty_delta) AS total
            FROM public.stock_ledger l WHERE l.wholesaler_id = v_wid AND l.inbound_scan_id IS NOT NULL GROUP BY l.inbound_scan_id
        ) lb ON lb.inbound_scan_id = s.id
        LEFT JOIN public.products p ON p.id = s.product_id
        WHERE s.wholesaler_id = v_wid AND s.remaining_weight <> lb.total
        ORDER BY abs(s.remaining_weight - lb.total) DESC, s.trace_no
        LIMIT 200
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_stock_repairs(p_limit integer DEFAULT 30)
 RETURNS TABLE(id uuid, kind text, target_label text, basis text, before_current numeric, before_ledger numeric, after_value numeric, actual_input numeric, valuation_change numeric, reason text, repaired_by_name text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    IF NOT public.feature_effective(v_wid, 'accounting_integrity') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    RETURN QUERY
    SELECT r.id, r.kind, r.target_label, r.basis, r.before_current, r.before_ledger, r.after_value, r.actual_input, r.valuation_change,
           r.reason, COALESCE(pr.name, '알 수 없음'), r.created_at
    FROM public.stock_repairs r
    LEFT JOIN public.profiles pr ON pr.id = r.repaired_by
    WHERE r.wholesaler_id = v_wid
    ORDER BY r.created_at DESC, r.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 200);
END;
$function$;

CREATE OR REPLACE FUNCTION public.repair_stock_mismatch(p_kind text, p_id uuid, p_basis text, p_actual numeric, p_reason text, p_expected_current numeric, p_expected_ledger numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_wid      uuid := public.resolve_current_wholesaler_id();
    v_reason   text := btrim(COALESCE(p_reason, ''));
    v_product  public.products%ROWTYPE;
    v_box      public.inbound_scans%ROWTYPE;
    v_current  numeric;
    v_ledger   numeric;
    v_after    numeric;
    v_delta    numeric;
    v_label    text;
    v_product_id uuid;
    v_change   numeric;
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    IF NOT public.feature_effective(v_wid, 'accounting_integrity') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    IF p_kind NOT IN ('product', 'box') THEN
        RAISE EXCEPTION 'INVALID_KIND';
    END IF;

    IF p_basis NOT IN ('LEDGER', 'ACTUAL') THEN
        RAISE EXCEPTION 'INVALID_BASIS';
    END IF;

    IF char_length(v_reason) < 2 OR char_length(v_reason) > 200 THEN
        RAISE EXCEPTION 'REASON_REQUIRED';
    END IF;

    IF p_basis = 'ACTUAL' AND (p_actual IS NULL OR p_actual < 0) THEN
        RAISE EXCEPTION 'INVALID_ACTUAL';
    END IF;

    IF p_kind = 'box' THEN
        -- 잠금 순서: 박스 → 상품 (다른 입출고 함수와 같다)
        SELECT * INTO v_box FROM public.inbound_scans WHERE id = p_id AND wholesaler_id = v_wid FOR UPDATE;

        IF v_box.id IS NULL THEN
            RAISE EXCEPTION 'TARGET_NOT_FOUND';
        END IF;

        SELECT sum(qty_delta) INTO v_ledger FROM public.stock_ledger WHERE inbound_scan_id = v_box.id;

        IF v_ledger IS NULL THEN
            RAISE EXCEPTION 'NO_LEDGER';
        END IF;

        v_current := v_box.remaining_weight;
        v_product_id := v_box.product_id;
        v_label := v_box.trace_no;
    ELSE
        SELECT * INTO v_product FROM public.products WHERE id = p_id AND wholesaler_id = v_wid FOR UPDATE;

        IF v_product.id IS NULL THEN
            RAISE EXCEPTION 'TARGET_NOT_FOUND';
        END IF;

        SELECT sum(qty_delta) INTO v_ledger FROM public.stock_ledger WHERE product_id = v_product.id;

        IF v_ledger IS NULL THEN
            RAISE EXCEPTION 'NO_LEDGER';
        END IF;

        v_current := v_product.stock_quantity;
        v_product_id := v_product.id;
        v_label := v_product.name;
    END IF;

    IF v_current IS DISTINCT FROM p_expected_current OR v_ledger IS DISTINCT FROM p_expected_ledger THEN
        RAISE EXCEPTION 'STALE';
    END IF;

    IF v_current = v_ledger THEN
        RAISE EXCEPTION 'NOT_MISMATCHED';
    END IF;

    IF p_basis = 'LEDGER' THEN
        v_after := v_ledger;

        IF p_kind = 'box' THEN
            IF v_after < 0 OR v_after > v_box.weight THEN
                RAISE EXCEPTION 'LEDGER_OUT_OF_RANGE';
            END IF;

            UPDATE public.inbound_scans SET remaining_weight = v_after WHERE id = v_box.id;
        END IF;
    ELSE
        v_after := p_actual;

        IF p_kind = 'box' AND v_after > v_box.weight THEN
            RAISE EXCEPTION 'ACTUAL_OVER_WEIGHT';
        END IF;

        -- 남은 박스가 있는 상품의 재고를 박스 합계보다 적게 맞추면 "남은 박스 합계 > 재고"라는 새 어긋남이 생긴다 — 박스 단위로 보정해야 한다.
        IF p_kind = 'product' AND v_after + 0.0005 < COALESCE((
            SELECT sum(remaining_weight) FROM public.inbound_scans
            WHERE product_id = v_product.id AND status = 'NORMAL' AND remaining_weight > 0
        ), 0) THEN
            RAISE EXCEPTION 'ACTUAL_BELOW_BOXES';
        END IF;

        v_delta := v_after - v_ledger;

        IF v_delta <> 0 THEN
            IF p_kind = 'box' AND v_product_id IS NULL THEN
                RAISE EXCEPTION 'NO_PRODUCT';
            END IF;

            INSERT INTO public.stock_ledger (
                wholesaler_id, product_id, inbound_scan_id, qty_delta,
                event_type, source_type, source_id, reason, created_by
            ) VALUES (
                v_wid, v_product_id, CASE WHEN p_kind = 'box' THEN v_box.id ELSE NULL END, v_delta,
                'ADJUSTMENT', 'manual', NULL,
                '재고 점검 보정(실물 기준) — ' || v_reason,
                auth.uid()
            );
        END IF;

        IF p_kind = 'box' THEN
            UPDATE public.inbound_scans SET remaining_weight = v_after WHERE id = v_box.id;
        END IF;
    END IF;

    -- 재고 평가금액 변화(박스 단위 + 매입단가를 아는 경우만). 상품 단위 보정은 어느 박스인지 몰라 계산하지 않는다.
    IF p_kind = 'box' AND v_box.purchase_unit_price IS NOT NULL THEN
        v_change := round((v_after - v_current) * v_box.purchase_unit_price, 0);
    END IF;

    -- 상품 재고 숫자는 장부 합계를 다시 계산한다(박스 보정이 상품 재고에 반영되도록, 상품 보정은 이것이 곧 보정이다)
    IF v_product_id IS NOT NULL THEN
        PERFORM public.recalc_product_stock(v_product_id);
    END IF;

    INSERT INTO public.stock_repairs (
        wholesaler_id, kind, target_id, target_label, basis,
        before_current, before_ledger, after_value, actual_input, valuation_change, reason, repaired_by
    ) VALUES (
        v_wid, p_kind, p_id, v_label, p_basis,
        v_current, v_ledger, v_after, CASE WHEN p_basis = 'ACTUAL' THEN p_actual ELSE NULL END, v_change, v_reason, auth.uid()
    );

    RETURN jsonb_build_object('kind', p_kind, 'target_id', p_id, 'before_current', v_current, 'before_ledger', v_ledger, 'after', v_after, 'valuation_change', v_change);
END;
$function$;
