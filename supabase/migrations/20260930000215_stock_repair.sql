-- 재고 점검 보정 (2026-10-02) — 어긋난 상품 재고·박스 잔량을 업체 대표가 화면에서 확인하고 고친다
--
-- 매일 점검(213)이 잡아내는 것 중 "고칠 수 있는 두 가지"만 다룬다:
--   · 상품 재고 숫자 ≠ 장부(원장) 합계
--   · 박스 잔량 ≠ 그 박스의 장부 합계
-- 무엇이 진실인지는 업체가 고른다(대표 결정): "장부가 맞다"(재고·잔량을 장부에 맞춤) / "실물이 맞다"(실사한 수량을 넣으면
-- 장부에 그 차이만큼 보정 기록을 추가). 과거 기록은 고치지 않는다. 화면과 사이에 숫자가 바뀌었으면(STALE) 거부한다.
-- 입출고를 막지 않는다 — 이 기능은 사후에 바로잡는 도구일 뿐이다. 업체 대표 전용(자기 업체만).

-- 보정 이력: 누가 언제 무엇을 어떤 기준으로 왜 고쳤는지. 고치거나 지울 수 없다(쓰기 정책·권한 없음, 함수만 쓴다).
CREATE TABLE IF NOT EXISTS public.stock_repairs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id  uuid NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    kind           text NOT NULL CHECK (kind IN ('product', 'box')),
    target_id      uuid NOT NULL,
    target_label   text NOT NULL,
    basis          text NOT NULL CHECK (basis IN ('LEDGER', 'ACTUAL')),
    before_current numeric(10, 3) NOT NULL,
    before_ledger  numeric(10, 3) NOT NULL,
    after_value    numeric(10, 3) NOT NULL,
    actual_input   numeric(10, 3),
    -- 재고 평가금액이 얼마나 바뀌었나(원, 줄면 음수) = (보정 후 − 보정 전 잔량) × 그 박스의 매입단가. 박스 단위 보정에서 단가를 알 때만 값이 있다.
    -- 실물이 장부보다 적어서 줄이는 보정이면 이 금액이 곧 손실이다 — 기간별 손익을 만들 때 합산한다.
    valuation_change numeric(14, 0),
    reason         text NOT NULL,
    repaired_by    uuid,
    created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.stock_repairs ADD COLUMN IF NOT EXISTS valuation_change numeric(14, 0);

CREATE INDEX IF NOT EXISTS idx_stock_repairs_wholesaler ON public.stock_repairs (wholesaler_id, created_at DESC);

ALTER TABLE public.stock_repairs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Stock repairs viewable by owner" ON public.stock_repairs;
CREATE POLICY "Stock repairs viewable by owner"
    ON public.stock_repairs FOR SELECT TO authenticated USING (public.is_wholesaler_owner(wholesaler_id));

REVOKE ALL ON public.stock_repairs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stock_repairs FROM authenticated;

-- 이력은 고칠 수 없다: UPDATE/DELETE를 트리거로도 막는다(함수 소유자 포함). 업체 삭제로 인한 연쇄 삭제는 허용해야 하므로 DELETE는 건드리지 않는다.
CREATE OR REPLACE FUNCTION public.guard_stock_repairs_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
    RAISE EXCEPTION 'HISTORY_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_stock_repairs_immutable ON public.stock_repairs;
CREATE TRIGGER trg_guard_stock_repairs_immutable
    BEFORE UPDATE ON public.stock_repairs
    FOR EACH ROW EXECUTE FUNCTION public.guard_stock_repairs_immutable();

REVOKE ALL ON FUNCTION public.guard_stock_repairs_immutable() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.list_stock_mismatches();
DROP FUNCTION IF EXISTS public.list_stock_repairs(integer);

-- 어긋난 항목 목록(대표 전용, 자기 업체만). 장부 기록이 있는 상품·박스만 대상이다 — 원장 도입 전 수동 재고·확인 필요 박스는 어긋남이 아니다.
CREATE OR REPLACE FUNCTION public.list_stock_mismatches()
RETURNS TABLE (
    kind          text,
    target_id     uuid,
    label         text,
    unit          text,
    current_value numeric,
    ledger_value  numeric,
    diff          numeric,
    box_weight    numeric,
    unit_price    numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
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
$$;

-- 보정 적용. p_basis: 'LEDGER'(장부가 맞다) / 'ACTUAL'(실물이 맞다 — p_actual에 실사 수량).
-- p_expected_current·p_expected_ledger: 화면이 본 값. 그 사이 바뀌었으면 STALE로 거부한다.
CREATE OR REPLACE FUNCTION public.repair_stock_mismatch(
    p_kind text,
    p_id uuid,
    p_basis text,
    p_actual numeric,
    p_reason text,
    p_expected_current numeric,
    p_expected_ledger numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
$$;


-- 한 박스 또는 한 상품의 입출고 기록(장부 한 줄씩, 최근 100건). 보정 화면이 "장부가 맞다 / 실물이 맞다"를 고르는 근거로 보여준다.
-- 대표 전용·자기 업체만. 합계가 곧 장부 값이라 눈으로 검증할 수 있다.
DROP FUNCTION IF EXISTS public.list_stock_movements(text, uuid);

CREATE FUNCTION public.list_stock_movements(p_kind text, p_id uuid)
RETURNS TABLE (
    created_at   timestamptz,
    event_type   text,
    qty_delta    numeric,
    source_type  text,
    order_number text,
    reason       text,
    actor_name   text,
    box_trace_no text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    IF p_kind = 'box' THEN
        IF NOT EXISTS (SELECT 1 FROM public.inbound_scans s WHERE s.id = p_id AND s.wholesaler_id = v_wid) THEN
            RAISE EXCEPTION 'TARGET_NOT_FOUND';
        END IF;
    ELSIF p_kind = 'product' THEN
        IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = p_id AND p.wholesaler_id = v_wid) THEN
            RAISE EXCEPTION 'TARGET_NOT_FOUND';
        END IF;
    ELSE
        RAISE EXCEPTION 'INVALID_KIND';
    END IF;

    RETURN QUERY
    SELECT l.created_at, l.event_type, l.qty_delta, l.source_type,
           o.order_number::text, l.reason, pr.name::text, s.trace_no::text
    FROM public.stock_ledger l
    LEFT JOIN public.orders o ON l.source_type = 'order' AND o.id = l.source_id
    LEFT JOIN public.profiles pr ON pr.id = l.created_by
    LEFT JOIN public.inbound_scans s ON s.id = l.inbound_scan_id
    WHERE l.wholesaler_id = v_wid
      AND ((p_kind = 'box' AND l.inbound_scan_id = p_id) OR (p_kind = 'product' AND l.product_id = p_id))
    ORDER BY l.created_at DESC, l.id
    LIMIT 100;
END;
$$;

-- 최근 보정 이력(대표 전용, 자기 업체만)
CREATE OR REPLACE FUNCTION public.list_stock_repairs(p_limit integer DEFAULT 30)
RETURNS TABLE (
    id uuid, kind text, target_label text, basis text,
    before_current numeric, before_ledger numeric, after_value numeric, actual_input numeric, valuation_change numeric,
    reason text, repaired_by_name text, created_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
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
$$;

REVOKE ALL ON FUNCTION public.list_stock_mismatches() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.repair_stock_mismatch(text, uuid, text, numeric, text, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_stock_repairs(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_stock_mismatches() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.repair_stock_mismatch(text, uuid, text, numeric, text, numeric, numeric) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_stock_movements(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_stock_movements(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_stock_repairs(integer) TO authenticated, service_role;
