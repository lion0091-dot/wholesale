-- ====================================================================
-- 입고 실중량 검수 + 매입금액 자동 산정 (24단계)
--
-- 현장 루틴을 끝까지 채운다:
--   스캔(이력번호) → 검증(공공 API) → 측정(저울에 올린 실중량) → 확정(매입금액)
--
-- 지금까지는 "중량" 칸이 하나뿐이라, 바코드에 실려 온 표기중량(GS1-128 AI 3103)과
-- 저울에 찍힌 실중량이 같은 칸을 놓고 다퉜다. 표기 20kg / 실측 19.8kg인 박스를
-- 20kg으로 받으면 200g씩 돈을 더 주고, 재고도 200g씩 부풀어 출고에서 어긋난다.
--
-- 잠긴 설계 결정:
--
--  1. 재고에 반영되는 건 언제나 실중량이다. 표기중량(labeled_weight)은 대조용으로
--     따로 남긴다. 기존 weight 컬럼이 곧 실중량이라 원장·출고·정산은 손대지 않는다.
--
--  2. 차이가 나도 입고를 막지 않는다. 물건은 이미 창고에 들어와 있다(1단계와 같은
--     원칙). 허용 오차(±2%)를 넘으면 화면에서 눈에 띄게 알리고 집계에 남긴다 —
--     목적은 차단이 아니라 "어느 매입처가 반복적으로 덜 보내는가"를 드러내는 것이다.
--
--  3. 매입금액은 실중량 기준이다. 표기중량으로 청구받으면 그 차이가 그대로 손실이다.
--
--  4. 매입단가는 상품별 기본값 + 건별 스냅샷이다. 스캔 시점의 단가가 박스에
--     복사되므로, 나중에 기본단가를 바꿔도 과거 매입금액은 흔들리지 않는다.
--
--  5. 매입금액은 계산 컬럼(GENERATED)으로 둔다. 단가를 나중에 채워 넣어도 금액이
--     자동으로 따라오고, 중량과 금액이 어긋난 행이 물리적으로 존재할 수 없다.
--
--  6. 금액은 원장(stock_ledger)에 넣지 않는다. 원장은 수량의 진실이고 돈은 별개다.
--     섞으면 재고 재계산이 금액 변경에 끌려다닌다.
-- ====================================================================


-- --------------------------------------------------------------------
-- 1. INBOUND_SCANS — 표기중량 / 매입단가 / 매입처
-- --------------------------------------------------------------------
ALTER TABLE public.inbound_scans
    ADD COLUMN IF NOT EXISTS labeled_weight      NUMERIC(10, 3) CHECK (labeled_weight > 0),
    ADD COLUMN IF NOT EXISTS purchase_unit_price NUMERIC(12, 2) CHECK (purchase_unit_price >= 0),
    ADD COLUMN IF NOT EXISTS purchase_supplier   TEXT;

-- 실중량 - 표기중량. 음수면 덜 온 것이다.
ALTER TABLE public.inbound_scans
    ADD COLUMN IF NOT EXISTS weight_variance NUMERIC(10, 3)
    GENERATED ALWAYS AS (weight - labeled_weight) STORED;

-- 원 단위로 떨어뜨린다. 축산 매입에서 원 미만은 쓰지 않는다.
ALTER TABLE public.inbound_scans
    ADD COLUMN IF NOT EXISTS purchase_amount NUMERIC(14, 2)
    GENERATED ALWAYS AS (ROUND(weight * purchase_unit_price, 0)) STORED;

-- 오차 큰 건만 훑는 조회가 잦다.
CREATE INDEX IF NOT EXISTS idx_inbound_scans_variance
    ON public.inbound_scans (wholesaler_id, created_at DESC)
    WHERE weight_variance IS NOT NULL AND weight_variance <> 0;

CREATE INDEX IF NOT EXISTS idx_inbound_scans_purchase
    ON public.inbound_scans (wholesaler_id, created_at DESC)
    WHERE purchase_amount IS NOT NULL;


-- 표기중량 대비 몇 %까지는 정상으로 볼 것인가. 화면(TS)과 값을 맞춰야 한다
-- (lib/livestock/weight-variance.ts).
CREATE OR REPLACE FUNCTION public.inbound_weight_tolerance()
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$ SELECT 0.02::numeric $$;


-- --------------------------------------------------------------------
-- 2. PRODUCT_PURCHASE_PRICES — 상품별 기본 매입단가
--    판매가(products.base_price)와 성격이 달라 같은 테이블에 두지 않는다.
--    판매가는 고객에게 보이는 값이고 매입가는 업체 내부 원가다.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_purchase_prices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    product_id    UUID NOT NULL UNIQUE REFERENCES public.products(id) ON DELETE CASCADE,
    unit_price    NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    -- 기본 매입처(도축장·거래처). 스캔할 때 비워두면 이 값이 따라 들어간다.
    supplier_name TEXT,
    updated_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.product_purchase_prices ENABLE ROW LEVEL SECURITY;

-- 원가는 고객에게 절대 보이면 안 된다 — 바이어 분기를 아예 두지 않는다.
CREATE POLICY "Purchase prices viewable by owner, org staff, or admin" ON public.product_purchase_prices
    FOR SELECT USING (
        public.can_access_wholesaler(wholesaler_id)
    );

DROP TRIGGER IF EXISTS trg_product_purchase_prices_updated_at ON public.product_purchase_prices;
CREATE TRIGGER trg_product_purchase_prices_updated_at
    BEFORE UPDATE ON public.product_purchase_prices
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


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

    -- 매입단가는 원가라 화면(app/dashboard/purchases/actions.ts의 PURCHASE_ROLES)에서
    -- owner/manager만 고치게 막아뒀다. resolve_current_wholesaler_id()는 staff도
    -- 통과시키므로 여기서도 같은 게이트를 건다.
    IF v_wholesaler_id <> public.get_current_wholesaler_id()
       AND NOT public.is_org_staff_of_wholesaler(v_wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[]) THEN
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

REVOKE EXECUTE ON FUNCTION public.set_product_purchase_price(UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_product_purchase_price(UUID, NUMERIC, TEXT) TO authenticated;


-- --------------------------------------------------------------------
-- 3. RECORD_INBOUND_SCAN — 표기중량·매입단가를 함께 받는다.
--    22단계와 같은 방식: 본문(record_inbound_scan_base)은 그대로 두고 껍데기만
--    다시 만든다. 인자 개수가 겹치면 호출이 모호해지므로 이전 껍데기는 DROP한다.
-- --------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, DATE
);

CREATE FUNCTION public.record_inbound_scan(
    p_trace_no            TEXT,
    p_weight              NUMERIC,
    p_scan_type           TEXT,
    p_product_id          UUID    DEFAULT NULL,
    p_fail_reason         TEXT    DEFAULT NULL,
    p_import_row_id       UUID    DEFAULT NULL,
    p_memo                TEXT    DEFAULT NULL,
    p_confirm_duplicate   BOOLEAN DEFAULT false,
    p_best_before         DATE    DEFAULT NULL,
    -- 바코드/라벨에 적힌 중량. 저울 값(p_weight)과 대조한다.
    p_labeled_weight      NUMERIC DEFAULT NULL,
    -- 건별 매입단가. 비우면 상품별 기본 매입단가를 가져온다.
    p_purchase_unit_price NUMERIC DEFAULT NULL,
    p_purchase_supplier   TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result    JSONB;
    v_scan_id   UUID;
    v_scan      public.inbound_scans%ROWTYPE;
    v_default   public.product_purchase_prices%ROWTYPE;
    v_price     NUMERIC(12, 2);
    v_supplier  TEXT;
BEGIN
    v_result := public.record_inbound_scan_base(
        p_trace_no, p_weight, p_scan_type, p_product_id,
        p_fail_reason, p_import_row_id, p_memo, p_confirm_duplicate
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
            -- 이미 지난 물건도 받아는 준다 (22단계 설계 결정 3번). 대신 알린다.
            'expired',     p_best_before < CURRENT_DATE
        );
    END IF;

    -- 상품이 확정된 건만 기본 매입단가를 가져올 수 있다 (매핑 대기 건은 나중에 채운다).
    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = v_scan_id;

    IF v_scan.product_id IS NOT NULL THEN
        SELECT * INTO v_default
        FROM public.product_purchase_prices WHERE product_id = v_scan.product_id;
    END IF;

    v_price    := COALESCE(p_purchase_unit_price, v_default.unit_price);
    v_supplier := COALESCE(
        NULLIF(btrim(COALESCE(p_purchase_supplier, '')), ''),
        v_default.supplier_name
    );

    UPDATE public.inbound_scans
    SET labeled_weight      = COALESCE(p_labeled_weight, labeled_weight),
        purchase_unit_price = v_price,
        purchase_supplier   = v_supplier
    WHERE id = v_scan_id
    RETURNING * INTO v_scan;

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
        'purchase_unit_price', v_scan.purchase_unit_price,
        'purchase_amount',     v_scan.purchase_amount,
        'purchase_supplier',   v_scan.purchase_supplier
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, DATE, NUMERIC, NUMERIC, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_inbound_scan(
    TEXT, NUMERIC, TEXT, UUID, TEXT, UUID, TEXT, BOOLEAN, DATE, NUMERIC, NUMERIC, TEXT
) TO authenticated;


-- 스캔할 때 단가를 몰랐던 건(매핑 대기 등)을 나중에 채운다.
CREATE OR REPLACE FUNCTION public.update_inbound_purchase(
    p_scan_id       UUID,
    p_unit_price    NUMERIC,
    p_supplier_name TEXT DEFAULT NULL,
    p_apply_default BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    IF v_scan.id IS NULL OR v_scan.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    -- 매입단가는 원가라 owner/manager만 고칠 수 있다 (set_product_purchase_price와 동일 게이트).
    IF v_wholesaler_id <> public.get_current_wholesaler_id()
       AND NOT public.is_org_staff_of_wholesaler(v_wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[]) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF p_unit_price IS NULL OR p_unit_price < 0 THEN
        RAISE EXCEPTION 'INVALID_UNIT_PRICE';
    END IF;

    UPDATE public.inbound_scans
    SET purchase_unit_price = p_unit_price,
        purchase_supplier   = COALESCE(NULLIF(btrim(COALESCE(p_supplier_name, '')), ''), purchase_supplier)
    WHERE id = p_scan_id
    RETURNING * INTO v_scan;

    -- "앞으로 이 단가를 기본으로" — 같은 상품을 다음에 찍을 때 자동으로 붙는다.
    IF p_apply_default AND v_scan.product_id IS NOT NULL THEN
        PERFORM public.set_product_purchase_price(v_scan.product_id, p_unit_price, p_supplier_name);
    END IF;

    RETURN jsonb_build_object(
        'scan_id',         v_scan.id,
        'purchase_amount', v_scan.purchase_amount
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_inbound_purchase(UUID, NUMERIC, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_inbound_purchase(UUID, NUMERIC, TEXT, BOOLEAN) TO authenticated;


-- --------------------------------------------------------------------
-- 4. 매입 정산 조회
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_inbound_purchases(
    p_from       DATE    DEFAULT NULL,
    p_to         DATE    DEFAULT NULL,
    p_product_id UUID    DEFAULT NULL,
    p_supplier   TEXT    DEFAULT NULL,
    p_only_gap   BOOLEAN DEFAULT false,
    p_limit      INTEGER DEFAULT 200
)
RETURNS TABLE (
    scan_id           UUID,
    scanned_at        TIMESTAMPTZ,
    trace_no          TEXT,
    product_id        UUID,
    product_name      TEXT,
    labeled_weight    NUMERIC,
    actual_weight     NUMERIC,
    weight_variance   NUMERIC,
    variance_ratio    NUMERIC,
    unit_price        NUMERIC,
    purchase_amount   NUMERIC,
    purchase_supplier TEXT,
    status            TEXT,
    scanned_by        TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
        pr.name
    FROM public.inbound_scans s
    LEFT JOIN public.products p  ON p.id = s.product_id
    LEFT JOIN public.profiles pr ON pr.id = s.scanned_by
    WHERE s.wholesaler_id = public.resolve_current_wholesaler_id()
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
$$;

REVOKE EXECUTE ON FUNCTION public.list_inbound_purchases(DATE, DATE, UUID, TEXT, BOOLEAN, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_inbound_purchases(DATE, DATE, UUID, TEXT, BOOLEAN, INTEGER) TO authenticated;


CREATE OR REPLACE FUNCTION public.summarize_inbound_purchases(
    p_from       DATE DEFAULT NULL,
    p_to         DATE DEFAULT NULL,
    p_product_id UUID DEFAULT NULL,
    p_supplier   TEXT DEFAULT NULL
)
RETURNS TABLE (
    box_count        INTEGER,
    labeled_total    NUMERIC,
    actual_total     NUMERIC,
    variance_total   NUMERIC,
    purchase_total   NUMERIC,
    -- 단가가 아직 안 들어간 박스. 이 숫자가 0이 아니면 매입 합계는 아직 미완성이다.
    unpriced_count   INTEGER,
    -- 허용 오차를 넘은 박스
    over_gap_count   INTEGER,
    -- 덜 온 만큼을 표기중량 단가로 환산한 금액 (안 내도 됐을 돈)
    variance_amount  NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
      AND s.status <> 'VOIDED'
      AND (p_from IS NULL OR s.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR s.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR s.product_id = p_product_id)
      AND (
            NULLIF(btrim(COALESCE(p_supplier, '')), '') IS NULL
         OR s.purchase_supplier ILIKE '%' || btrim(p_supplier) || '%'
      );
$$;

REVOKE EXECUTE ON FUNCTION public.summarize_inbound_purchases(DATE, DATE, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summarize_inbound_purchases(DATE, DATE, UUID, TEXT) TO authenticated;
