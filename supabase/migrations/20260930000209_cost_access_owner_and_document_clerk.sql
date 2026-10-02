-- 원가(매입 비용) 접근을 "대표 + 전표 담당 직원(회사당 최대 2명)"으로 제한 (2026-10-02, 사장님 결정)
--
-- 원가가 담긴 곳 3군데:
--   ① inbound_scans.purchase_unit_price / purchase_amount  (입고 박스별 매입단가·금액)
--   ② purchase_order_lines.unit_price                       (전표 줄 단가)
--   ③ product_purchase_prices                               (상품별 기본 매입단가)
-- 누가 볼 수 있나(can_view_cost): 대표(wholesalers 본인 또는 조직 owner) + 전표 담당으로 지정된 직원.
--   매니저·일반 직원·고객·슈퍼관리자·비로그인은 못 본다. 매니저는 전표·매입 정산에서도 빠진다.
--
-- 컬럼 SELECT 권한은 DB 역할(authenticated) 단위라 "대표만 열기"가 안 된다 → ①②는 컬럼 직접 조회를 전부 막고,
--   읽는 쪽(대표·전표 담당)은 get_scan_costs / get_po_line_prices 함수로만 읽는다.
--   실시간(Realtime) payload에도 막은 컬럼은 실리지 않는다(2026-10-02 로컬 실험으로 확인).
--   ★ 위 두 표에 컬럼을 새로 추가하면 아래 "컬럼 권한 재부여"를 같이 해야 한다. 안 하면 화면이 permission denied로 깨진다
--     (scripts/db-test-cost-access.sql이 빠진 컬럼을 잡는다).

-- ============================================================
-- 0. 업체별 정책 (플랫폼 원칙: 도매업체마다 요청이 다르니 고정값으로 박지 않는다 — 대표 지시 2026-10-02)
--    기본값은 기존 동작과 같다(대표 + 매니저 + 전표 담당 직원) — 요청한 업체만 좁힌다("원하는 업체만 적용").
--    바꾸는 건 플랫폼 운영자(슈퍼관리자)만 — 업체 대표가 스스로 열거나 닫을 수 없다.
--      OWNER_ONLY               대표만
--      OWNER_AND_CLERK          대표 + 전표 담당 직원 (매니저 제외)
--      OWNER_MANAGER_AND_CLERK  대표 + 매니저 + 전표 담당 직원 (기본, 기존과 같음)
-- ============================================================
ALTER TABLE public.wholesalers
    ADD COLUMN IF NOT EXISTS cost_access_policy text NOT NULL DEFAULT 'OWNER_MANAGER_AND_CLERK'
        CHECK (cost_access_policy IN ('OWNER_ONLY', 'OWNER_AND_CLERK', 'OWNER_MANAGER_AND_CLERK')),
    ADD COLUMN IF NOT EXISTS document_clerk_limit integer NOT NULL DEFAULT 2
        CHECK (document_clerk_limit BETWEEN 0 AND 10);

-- 두 정책 컬럼은 비밀이 아니다 — 화면(설정·운영 화면)이 읽을 수 있어야 한다. 쓰기는 플랫폼 전용 컬럼 보호 트리거가 막는다(아래 9번).
-- (wholesalers는 컬럼 단위 권한이라, 새 컬럼은 명시적으로 열어야 한다 — scripts/db-test-alimtalk-credentials.sql이 누락을 잡는다.)
GRANT SELECT (cost_access_policy, document_clerk_limit) ON public.wholesalers TO authenticated;

-- ============================================================
-- 1. 전표 담당 표시 (organization_staff)
-- ============================================================
ALTER TABLE public.organization_staff
    ADD COLUMN IF NOT EXISTS is_document_clerk boolean NOT NULL DEFAULT false;

-- 규칙: 일반 직원(staff)만 전표 담당이 될 수 있다 / 최대 인원은 업체 설정(wholesalers.document_clerk_limit, 기본 2) / 켜는 건 대표가 set_document_clerk로만.
CREATE OR REPLACE FUNCTION public.enforce_document_clerk_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
    -- 직원이 아니게 되면(매니저 승격 등) 전표 담당 표시는 조용히 내려간다.
    IF NEW.role <> 'staff' THEN
        NEW.is_document_clerk := false;
    END IF;

    IF NEW.is_document_clerk AND (TG_OP = 'INSERT' OR NOT COALESCE(OLD.is_document_clerk, false)) THEN
        -- 새로 켜는 경우: 대표가 RPC로만. (서버·마이그레이션처럼 auth.uid()가 없는 경로는 통과)
        IF auth.uid() IS NOT NULL AND COALESCE(current_setting('app.document_clerk_rpc', true), '') <> 'on' THEN
            RAISE EXCEPTION 'FORBIDDEN';
        END IF;

        -- 같은 조직에서 동시에 켜는 경우를 막으려고 조직 행을 잠근다.
        PERFORM 1 FROM public.organizations WHERE id = NEW.organization_id FOR UPDATE;

        IF (SELECT count(*) FROM public.organization_staff s
             WHERE s.organization_id = NEW.organization_id AND s.is_document_clerk AND s.id <> NEW.id)
           >= COALESCE((SELECT w.document_clerk_limit FROM public.wholesalers w
                         JOIN public.organizations o ON o.wholesaler_id = w.id
                        WHERE o.id = NEW.organization_id), 2) THEN
            RAISE EXCEPTION 'DOCUMENT_CLERK_LIMIT';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_document_clerk_rules ON public.organization_staff;
CREATE TRIGGER trg_enforce_document_clerk_rules
    BEFORE INSERT OR UPDATE ON public.organization_staff
    FOR EACH ROW EXECUTE FUNCTION public.enforce_document_clerk_rules();

-- 트리거 내부용 — 로그인 사용자·익명이 직접 부를 이유가 없다.
REVOKE ALL ON FUNCTION public.enforce_document_clerk_rules() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 2. 권한 판정 헬퍼
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_document_clerk_of(p_wholesaler_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_staff s
        JOIN public.organizations o ON o.id = s.organization_id
        WHERE o.wholesaler_id = p_wholesaler_id
          AND s.user_id = auth.uid()
          AND s.role = 'staff'
          AND s.is_document_clerk
    );
$$;

-- 원가를 보고 입력할 수 있는 사람: 대표 + (업체 정책에 따라) 전표 담당 직원·매니저. 슈퍼관리자는 아니다 — 공급사의 영업 비밀.
CREATE OR REPLACE FUNCTION public.can_view_cost(p_wholesaler_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT COALESCE(
        p_wholesaler_id IS NOT NULL
        AND (
            p_wholesaler_id = public.get_current_wholesaler_id()
            OR public.is_org_staff_of_wholesaler(p_wholesaler_id, ARRAY['owner']::public.organization_role[])
            OR EXISTS (
                SELECT 1 FROM public.wholesalers w
                WHERE w.id = p_wholesaler_id
                  AND (
                      (w.cost_access_policy IN ('OWNER_AND_CLERK', 'OWNER_MANAGER_AND_CLERK')
                          AND public.is_document_clerk_of(w.id))
                      OR (w.cost_access_policy = 'OWNER_MANAGER_AND_CLERK'
                          AND public.is_org_staff_of_wholesaler(w.id, ARRAY['manager']::public.organization_role[]))
                  )
            )
        ),
        false
    );
$$;

-- ============================================================
-- 3. 전표 담당 지정·해제 (대표 전용)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_document_clerk(p_staff_id uuid, p_value boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_staff public.organization_staff%ROWTYPE;
    v_wholesaler_id uuid;
BEGIN
    SELECT * INTO v_staff FROM public.organization_staff WHERE id = p_staff_id;

    IF v_staff.id IS NULL THEN
        RAISE EXCEPTION 'STAFF_NOT_FOUND';
    END IF;

    SELECT o.wholesaler_id INTO v_wholesaler_id FROM public.organizations o WHERE o.id = v_staff.organization_id;

    IF NOT (
        COALESCE(v_wholesaler_id = public.get_current_wholesaler_id(), false)
        OR public.is_org_staff_of_wholesaler(v_wholesaler_id, ARRAY['owner']::public.organization_role[])
    ) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF p_value AND v_staff.role <> 'staff' THEN
        RAISE EXCEPTION 'ONLY_STAFF_CAN_BE_CLERK';
    END IF;

    PERFORM set_config('app.document_clerk_rpc', 'on', true);

    UPDATE public.organization_staff SET is_document_clerk = p_value WHERE id = p_staff_id;

    -- 같은 트랜잭션 안에서 이어지는 다른 문장이 이 표시를 빌려 쓰지 못하게 바로 끈다.
    PERFORM set_config('app.document_clerk_rpc', '', true);
END;
$$;

REVOKE ALL ON FUNCTION public.set_document_clerk(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_document_clerk(uuid, boolean) TO authenticated;

-- ============================================================
-- 4. 원가 읽기 함수 (컬럼 직접 조회를 막은 뒤 대표·전표 담당이 읽는 유일한 길)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_scan_costs(p_scan_ids uuid[])
RETURNS TABLE (scan_id uuid, unit_price numeric, amount numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    WITH me AS MATERIALIZED (
        SELECT t.wid, public.can_view_cost(t.wid) AS ok
        FROM (SELECT public.resolve_current_wholesaler_id() AS wid) t
    )
    SELECT s.id, s.purchase_unit_price, s.purchase_amount
    FROM me
    JOIN public.inbound_scans s ON s.wholesaler_id = me.wid AND me.ok
    WHERE s.id = ANY(p_scan_ids);
$$;

-- 권한 판정은 줄마다 다시 하지 않고 한 번만 계산한다((SELECT ...) 형태 — 행 컬럼을 참조하면 18,000줄에서 3초 넘게 걸렸다).
-- 전표 한 건당 한 행(줄번호 → 단가 JSON)으로 돌려준다 — 줄이 많은 전표 60건이면 수천~1만 줄이라, 줄 단위로 돌려주면
-- API의 한 번 응답 상한(기본 1,000행)에 걸려 일부 단가가 조용히 빠진다.
DROP FUNCTION IF EXISTS public.get_po_line_prices(uuid[]);

CREATE FUNCTION public.get_po_line_prices(p_order_ids uuid[])
RETURNS TABLE (order_id uuid, prices jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    WITH me AS MATERIALIZED (
        SELECT t.wid, public.can_view_cost(t.wid) AS ok
        FROM (SELECT public.resolve_current_wholesaler_id() AS wid) t
    )
    SELECT l.purchase_order_id, jsonb_object_agg(l.line_no::text, l.unit_price)
    FROM me
    JOIN public.purchase_order_lines l ON l.wholesaler_id = me.wid AND me.ok
    WHERE l.purchase_order_id = ANY(p_order_ids)
    GROUP BY l.purchase_order_id;
$$;

REVOKE ALL ON FUNCTION public.get_scan_costs(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_po_line_prices(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_scan_costs(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_po_line_prices(uuid[]) TO authenticated;

-- ============================================================
-- 5. 행 수준 정책 (RLS)
-- ============================================================
-- 상품별 기본 매입단가: 대표·전표 담당만 읽는다.
DROP POLICY IF EXISTS "Purchase prices viewable by owner, org staff, or admin" ON public.product_purchase_prices;
DROP POLICY IF EXISTS "Purchase prices viewable by cost viewers" ON public.product_purchase_prices;
CREATE POLICY "Purchase prices viewable by cost viewers"
    ON public.product_purchase_prices FOR SELECT
    USING (public.can_view_cost(wholesaler_id));

-- 전표(발주서)와 줄: 입력·수정은 대표 + 전표 담당 직원만(매니저는 빠진다). 읽기(진행 상황)는 기존대로 소속 전원 —
-- 단가 컬럼은 아래 컬럼 권한으로 따로 막는다.
DO $$ DECLARE v_name text; BEGIN
    SELECT policyname INTO v_name FROM pg_policies WHERE schemaname='public' AND tablename='purchase_orders' AND policyname IN ('Purchase orders managed by owner and manager','Purchase orders managed by cost viewers');
    EXECUTE format('ALTER POLICY %I ON public.purchase_orders USING (public.can_view_cost(wholesaler_id)) WITH CHECK (public.can_view_cost(wholesaler_id))', v_name);
END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='purchase_orders' AND policyname='Purchase orders managed by owner and manager') THEN
    ALTER POLICY "Purchase orders managed by owner and manager" ON public.purchase_orders RENAME TO "Purchase orders managed by cost viewers"; END IF; END $$;

DO $$ DECLARE v_name text; BEGIN
    SELECT policyname INTO v_name FROM pg_policies WHERE schemaname='public' AND tablename='purchase_order_lines' AND policyname IN ('Purchase order lines managed by owner and manager','Purchase order lines managed by cost viewers');
    EXECUTE format('ALTER POLICY %I ON public.purchase_order_lines USING (public.can_view_cost(wholesaler_id)) WITH CHECK (public.can_view_cost(wholesaler_id))', v_name);
END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='purchase_order_lines' AND policyname='Purchase order lines managed by owner and manager') THEN
    ALTER POLICY "Purchase order lines managed by owner and manager" ON public.purchase_order_lines RENAME TO "Purchase order lines managed by cost viewers"; END IF; END $$;

-- 공급처(거래처) 등록: 전표 입력 중에 "목록에 없는 거래처 추가"가 있으므로 전표 담당 직원도 가능하게.
DO $$ DECLARE v_name text; BEGIN
    SELECT policyname INTO v_name FROM pg_policies WHERE schemaname='public' AND tablename='suppliers' AND policyname IN ('Suppliers managed by owner and manager','Suppliers managed by owner, manager and document clerk');
    EXECUTE format('ALTER POLICY %I ON public.suppliers USING (public.can_manage_wholesaler(wholesaler_id) OR public.is_document_clerk_of(wholesaler_id))
    WITH CHECK (public.can_manage_wholesaler(wholesaler_id) OR public.is_document_clerk_of(wholesaler_id))', v_name);
END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='suppliers' AND policyname='Suppliers managed by owner and manager') THEN
    ALTER POLICY "Suppliers managed by owner and manager" ON public.suppliers RENAME TO "Suppliers managed by owner, manager and document clerk"; END IF; END $$;

-- ============================================================
-- 6. 컬럼 권한: 원가 컬럼 직접 조회 차단 (다른 컬럼은 그대로)
-- ============================================================
REVOKE SELECT ON public.inbound_scans FROM authenticated, anon;
REVOKE SELECT ON public.purchase_order_lines FROM authenticated, anon;
-- (익명에게도 원가 외 컬럼 권한은 다시 준다 — 행 보호(RLS)가 0건을 돌려주던 기존 동작을 "권한 오류"로 바꾸지 않으려는 것)

DO $$
DECLARE
    v_cols text;
BEGIN
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inbound_scans'
      AND column_name NOT IN ('purchase_unit_price', 'purchase_amount');
    EXECUTE 'GRANT SELECT (' || v_cols || ') ON public.inbound_scans TO authenticated, anon';

    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_order_lines'
      AND column_name NOT IN ('unit_price');
    EXECUTE 'GRANT SELECT (' || v_cols || ') ON public.purchase_order_lines TO authenticated, anon';
END $$;

-- ============================================================
-- 7. 기존 함수의 권한·응답 손보기 (로컬 DB의 pg_get_functiondef 기준으로 해당 줄만 바꿈)
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_inbound_scan(p_trace_no text, p_weight numeric, p_scan_type text, p_product_id uuid DEFAULT NULL::uuid, p_fail_reason text DEFAULT NULL::text, p_import_row_id uuid DEFAULT NULL::uuid, p_memo text DEFAULT NULL::text, p_confirm_duplicate boolean DEFAULT false, p_best_before date DEFAULT NULL::date, p_labeled_weight numeric DEFAULT NULL::numeric, p_purchase_unit_price numeric DEFAULT NULL::numeric, p_purchase_supplier text DEFAULT NULL::text, p_fail_detail text DEFAULT NULL::text, p_supplier_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_result        JSONB;
    v_scan_id       UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_default       public.product_purchase_prices%ROWTYPE;
    v_price         NUMERIC(12, 2);
    v_supplier      TEXT;
    v_supplier_name TEXT;
    v_po            JSONB;
BEGIN
    IF p_purchase_unit_price IS NOT NULL
       AND NOT public.can_view_cost(public.resolve_current_wholesaler_id()) THEN
        RAISE EXCEPTION 'FORBIDDEN_PURCHASE_PRICE';
    END IF;

    IF p_supplier_id IS NOT NULL THEN
        SELECT name INTO v_supplier_name
        FROM public.suppliers
        WHERE id = p_supplier_id AND wholesaler_id = public.resolve_current_wholesaler_id();

        IF v_supplier_name IS NULL THEN
            RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
        END IF;
    END IF;

    v_result := public.record_inbound_scan_base(
        p_trace_no, p_weight, p_scan_type, p_product_id,
        p_fail_reason, p_import_row_id, p_memo, p_confirm_duplicate,
        p_fail_detail
    );

    v_scan_id := NULLIF(v_result ->> 'scan_id', '')::UUID;

    IF v_scan_id IS NULL THEN
        RETURN v_result;
    END IF;

    IF p_best_before IS NOT NULL THEN
        UPDATE public.inbound_scans SET best_before = p_best_before WHERE id = v_scan_id;

        v_result := v_result || jsonb_build_object(
            'best_before', p_best_before,
            'days_left',   p_best_before - CURRENT_DATE,
            'expired',     p_best_before < CURRENT_DATE
        );
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = v_scan_id;

    IF v_scan.product_id IS NOT NULL THEN
        SELECT * INTO v_default
        FROM public.product_purchase_prices WHERE product_id = v_scan.product_id;
    END IF;

    v_price    := COALESCE(p_purchase_unit_price, v_default.unit_price);
    v_supplier := COALESCE(
        NULLIF(btrim(COALESCE(p_purchase_supplier, '')), ''),
        v_supplier_name,
        v_default.supplier_name
    );

    UPDATE public.inbound_scans
    SET labeled_weight      = COALESCE(p_labeled_weight, labeled_weight),
        purchase_unit_price = v_price,
        purchase_supplier   = v_supplier,
        supplier_id         = p_supplier_id
    WHERE id = v_scan_id
    RETURNING * INTO v_scan;

    IF p_supplier_id IS NOT NULL AND v_scan.status = 'NORMAL' THEN
        v_po := public.judge_scan_purchase_order(v_scan_id);
    END IF;

    RETURN v_result || jsonb_build_object(
        'labeled_weight',      v_scan.labeled_weight,
        'weight_variance',     v_scan.weight_variance,
        'variance_ratio',      CASE
                                   WHEN v_scan.labeled_weight IS NULL OR v_scan.labeled_weight = 0 THEN NULL
                                   ELSE ROUND(v_scan.weight_variance / v_scan.labeled_weight, 4)
                               END,
        'variance_exceeded',   CASE
                                   WHEN v_scan.labeled_weight IS NULL OR v_scan.labeled_weight = 0 THEN false
                                   ELSE abs(v_scan.weight_variance / v_scan.labeled_weight)
                                        > public.inbound_weight_tolerance()
                               END,
        'purchase_unit_price', CASE WHEN public.can_view_cost(v_scan.wholesaler_id) THEN v_scan.purchase_unit_price END,
        'purchase_amount',     CASE WHEN public.can_view_cost(v_scan.wholesaler_id) THEN v_scan.purchase_amount END,
        'purchase_supplier',   v_scan.purchase_supplier
    )
    || CASE
           WHEN v_po IS NULL THEN '{}'::jsonb
           WHEN v_po ->> 'result' = 'REJECTED' THEN jsonb_build_object('status', 'REJECTED', 'po', v_po)
           ELSE jsonb_build_object('po', v_po)
       END;
END;
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

CREATE OR REPLACE FUNCTION public.set_product_purchase_price(p_product_id uuid, p_unit_price numeric, p_supplier_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    -- 매입단가는 원가라 대표·전표 담당 직원만 (209).
    IF NOT public.can_view_cost(v_wholesaler_id) THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.create_retroactive_purchase_order(p_scan_id uuid, p_supplier_id uuid, p_ordered_on date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid       UUID;
    v_scan      public.inbound_scans%ROWTYPE;
    v_product   public.products%ROWTYPE;
    v_supplier  RECORD;
    v_amount    NUMERIC;
    v_order_id  UUID;
    v_line_id   UUID;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();

    IF v_wid IS NULL OR NOT public.can_view_cost(v_wid) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id AND wholesaler_id = v_wid FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status <> 'NORMAL' OR v_scan.product_id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_READY';
    END IF;

    SELECT id, name INTO v_supplier FROM public.suppliers WHERE id = p_supplier_id AND wholesaler_id = v_wid;

    IF v_supplier.id IS NULL THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
    END IF;

    v_amount := public.scan_unassigned_weight(p_scan_id);

    IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'NOTHING_TO_ASSIGN';
    END IF;

    SELECT * INTO v_product FROM public.products WHERE id = v_scan.product_id AND wholesaler_id = v_wid;

    IF v_product.id IS NULL THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    INSERT INTO public.purchase_orders (wholesaler_id, supplier_id, supplier_name, ordered_on, status, note)
    VALUES (
        v_wid, v_supplier.id, v_supplier.name, COALESCE(p_ordered_on, current_date), 'OPEN',
        '실물 입고 뒤 "발주서 추가 생성"으로 만들어짐'
    )
    RETURNING id INTO v_order_id;

    INSERT INTO public.purchase_order_lines (
        purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, unit, product_id
    ) VALUES (
        v_order_id, v_wid, 1, v_product.category, v_product.subcategory, v_product.grade, v_product.origin,
        v_product.breed, v_amount, COALESCE(v_product.unit, 'kg'), v_product.id
    )
    RETURNING id INTO v_line_id;

    INSERT INTO public.purchase_order_line_scans (scan_id, line_id, wholesaler_id, weight, linked_by)
    VALUES (p_scan_id, v_line_id, v_wid, v_amount, auth.uid());

    UPDATE public.inbound_scans SET po_state = 'ASSIGNED', po_detail = NULL WHERE id = p_scan_id;

    PERFORM public.refresh_purchase_order_completion(v_order_id);

    RETURN jsonb_build_object('order_id', v_order_id, 'line_id', v_line_id, 'amount', v_amount);
END;
$function$;

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
      AND s.status <> 'VOIDED'
      AND (p_from IS NULL OR s.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR s.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR s.product_id = p_product_id)
      AND (
            NULLIF(btrim(COALESCE(p_supplier, '')), '') IS NULL
         OR s.purchase_supplier ILIKE '%' || btrim(p_supplier) || '%'
      );
$function$;

CREATE OR REPLACE FUNCTION public.create_purchase_order_from_unlisted_scan(p_scan_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid       UUID;
    v_scan      public.inbound_scans%ROWTYPE;
    v_result    JSONB;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();

    IF v_wid IS NULL OR NOT public.can_view_cost(v_wid) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id AND wholesaler_id = v_wid;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.supplier_id IS NULL THEN
        RAISE EXCEPTION 'SCAN_HAS_NO_SUPPLIER';
    END IF;

    IF v_scan.po_state NOT IN ('UNLISTED_HELD', 'OVER_HELD') THEN
        RAISE EXCEPTION 'SCAN_NOT_HOLD';
    END IF;

    v_result := public.create_retroactive_purchase_order(p_scan_id, v_scan.supplier_id, v_scan.created_at::date);

    RETURN v_result;
END;
$function$;

-- ============================================================
-- 8. 팀원 목록에 전표 담당 표시를 함께 내려준다 (반환 컬럼이 늘어 DROP 후 재생성, 기존 권한 그대로)
-- ============================================================
DROP FUNCTION IF EXISTS public.list_organization_staff_with_profiles(uuid);

CREATE FUNCTION public.list_organization_staff_with_profiles(p_organization_id uuid)
 RETURNS TABLE(id uuid, user_id uuid, role organization_role, name text, phone text, created_at timestamp with time zone, is_document_clerk boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select s.id, s.user_id, s.role, p.name, p.phone, s.created_at, s.is_document_clerk
      from public.organization_staff s
      join public.profiles p on p.id = s.user_id
     where s.organization_id = p_organization_id
       and (
            public.has_organization_role(
                p_organization_id, array['owner', 'manager', 'staff']::public.organization_role[]
            )
            or public.get_current_role() = 'super_admin'
       )
     order by s.created_at asc;
$function$;

REVOKE ALL ON FUNCTION public.list_organization_staff_with_profiles(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_organization_staff_with_profiles(uuid) TO authenticated, service_role;

-- ============================================================
-- 9. 업체별 정책 컬럼은 플랫폼 운영자만 바꾼다 (업체 대표가 스스로 원가 열람 범위를 넓히지 못하게)
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_wholesaler_platform_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- 서비스 키·크론·SECURITY DEFINER RPC 내부(postgres/service_role)는 통과.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF public.get_current_role() = 'super_admin' THEN
        RETURN NEW;
    END IF;

    IF NEW.status                  IS DISTINCT FROM OLD.status
       OR NEW.subscription_status     IS DISTINCT FROM OLD.subscription_status
       OR NEW.trial_started_at        IS DISTINCT FROM OLD.trial_started_at
       OR NEW.billing_starts_at       IS DISTINCT FROM OLD.billing_starts_at
       OR NEW.nts_verification_status IS DISTINCT FROM OLD.nts_verification_status
       OR NEW.nts_verified_at         IS DISTINCT FROM OLD.nts_verified_at
       OR NEW.business_number         IS DISTINCT FROM OLD.business_number
       OR NEW.business_start_date     IS DISTINCT FROM OLD.business_start_date
       OR NEW.profile_id              IS DISTINCT FROM OLD.profile_id
       OR NEW.cost_access_policy      IS DISTINCT FROM OLD.cost_access_policy
       OR NEW.document_clerk_limit    IS DISTINCT FROM OLD.document_clerk_limit
    THEN
        RAISE EXCEPTION 'PLATFORM_ONLY_COLUMN';
    END IF;

    RETURN NEW;
END;
$function$;

-- 정책 판정 헬퍼는 로그인 사용자만 부른다(익명은 allowlist 밖 — scripts/db-test-anon-surface.sql). RLS 정책 안에서도 로그인 사용자 권한으로 평가된다.
REVOKE ALL ON FUNCTION public.can_view_cost(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_document_clerk_of(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_cost(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_document_clerk_of(uuid) TO authenticated, service_role;
