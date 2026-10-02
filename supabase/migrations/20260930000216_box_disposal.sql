-- 박스 단위 폐기 (2026-10-02) — 소비기한 경과·파손·변질 등으로 버리는 박스를 사유와 손실 금액과 함께 남긴다
--
-- 상품 단위 조정(055)은 수량만 LOSS로 남고 금액이 없다. 이 기능은 박스를 골라 일부 또는 전량을 폐기하고,
-- 장부(stock_ledger)에 LOSS를 박스 단위로 기록하며, 손실 금액 = 폐기 중량 × 그 박스의 매입단가(원 단위 반올림)를 이력에 같이 남긴다.
-- 대표(업체 owner) 전용. 이력은 고치거나 지울 수 없다(보정 이력 215와 같은 방식). 입출고를 막지 않는다.

CREATE TABLE IF NOT EXISTS public.box_disposals (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id    uuid NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    inbound_scan_id  uuid NOT NULL REFERENCES public.inbound_scans(id) ON DELETE CASCADE,
    product_id       uuid,
    trace_no         text NOT NULL,
    product_name     text,
    reason_code      text NOT NULL CHECK (reason_code IN ('EXPIRED', 'DAMAGE', 'SPOILED', 'OTHER')),
    note             text,
    weight           numeric(10, 3) NOT NULL CHECK (weight > 0),
    before_remaining numeric(10, 3) NOT NULL,
    after_remaining  numeric(10, 3) NOT NULL,
    -- 폐기 당시 박스 매입단가(모르면 NULL)와 손실 금액(원). 단가를 모르면 금액은 NULL — 수량만 기록된다.
    unit_price       numeric,
    loss_amount      numeric(14, 0),
    disposed_by      uuid,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_box_disposals_wholesaler ON public.box_disposals (wholesaler_id, created_at DESC);

ALTER TABLE public.box_disposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Box disposals viewable by owner" ON public.box_disposals;
CREATE POLICY "Box disposals viewable by owner"
    ON public.box_disposals FOR SELECT TO authenticated USING (public.is_wholesaler_owner(wholesaler_id));

REVOKE ALL ON public.box_disposals FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.box_disposals FROM authenticated;

-- 이력은 고칠 수 없다. 업체 삭제로 인한 연쇄 삭제는 허용해야 하므로 DELETE는 막지 않는다.
CREATE OR REPLACE FUNCTION public.guard_box_disposals_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
    RAISE EXCEPTION 'HISTORY_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_box_disposals_immutable ON public.box_disposals;
CREATE TRIGGER trg_guard_box_disposals_immutable
    BEFORE UPDATE ON public.box_disposals
    FOR EACH ROW EXECUTE FUNCTION public.guard_box_disposals_immutable();

REVOKE ALL ON FUNCTION public.guard_box_disposals_immutable() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.dispose_box(uuid, numeric, text, text, numeric);
DROP FUNCTION IF EXISTS public.list_box_disposals(integer);

-- 폐기. p_weight = 버리는 중량(잔량 이하, 일부 가능). p_expected_remaining = 화면이 본 잔량(그 사이 바뀌었으면 STALE).
CREATE FUNCTION public.dispose_box(
    p_box_id uuid,
    p_weight numeric,
    p_reason_code text,
    p_note text,
    p_expected_remaining numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_wid     uuid := public.resolve_current_wholesaler_id();
    v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
    v_box     public.inbound_scans%ROWTYPE;
    v_name    text;
    v_after   numeric;
    v_loss    numeric;
    v_label   text;
    v_id      uuid := gen_random_uuid();
BEGIN
    IF v_wid IS NULL OR NOT public.is_wholesaler_owner(v_wid) THEN
        RAISE EXCEPTION 'NOT_OWNER';
    END IF;

    v_label := CASE p_reason_code
        WHEN 'EXPIRED' THEN '소비기한 경과'
        WHEN 'DAMAGE'  THEN '파손'
        WHEN 'SPOILED' THEN '변질'
        WHEN 'OTHER'   THEN '기타'
        ELSE NULL
    END;

    IF v_label IS NULL THEN
        RAISE EXCEPTION 'INVALID_REASON';
    END IF;

    IF p_reason_code = 'OTHER' AND (v_note IS NULL OR char_length(v_note) < 2) THEN
        RAISE EXCEPTION 'NOTE_REQUIRED';
    END IF;

    IF v_note IS NOT NULL AND char_length(v_note) > 200 THEN
        RAISE EXCEPTION 'NOTE_TOO_LONG';
    END IF;

    IF p_weight IS NULL OR p_weight <= 0 OR p_weight <> round(p_weight, 3) THEN
        RAISE EXCEPTION 'INVALID_WEIGHT';
    END IF;

    -- 잠금 순서: 박스 → 상품 (다른 입출고 함수와 같다)
    SELECT * INTO v_box FROM public.inbound_scans WHERE id = p_box_id AND wholesaler_id = v_wid FOR UPDATE;

    IF v_box.id IS NULL THEN
        RAISE EXCEPTION 'TARGET_NOT_FOUND';
    END IF;

    IF v_box.status <> 'NORMAL' THEN
        RAISE EXCEPTION 'BOX_NOT_NORMAL';
    END IF;

    IF v_box.product_id IS NULL THEN
        RAISE EXCEPTION 'NO_PRODUCT';
    END IF;

    IF v_box.remaining_weight IS DISTINCT FROM p_expected_remaining THEN
        RAISE EXCEPTION 'STALE';
    END IF;

    IF p_weight > v_box.remaining_weight THEN
        RAISE EXCEPTION 'OVER_REMAINING';
    END IF;

    -- 장부 기록이 없는 박스(원장 도입 전)는 박스 잔량과 장부가 따로 놀게 되므로 이 화면에서 폐기하지 않는다.
    IF NOT EXISTS (SELECT 1 FROM public.stock_ledger WHERE inbound_scan_id = v_box.id) THEN
        RAISE EXCEPTION 'NO_LEDGER';
    END IF;

    -- 원장에 처음 편입되는 상품이면 기존 수동 재고를 기초재고로 먼저 옮긴다(055와 같다).
    PERFORM public.ensure_opening_balance(v_box.product_id);

    v_after := v_box.remaining_weight - p_weight;

    UPDATE public.inbound_scans SET remaining_weight = v_after WHERE id = v_box.id;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, reason, created_by
    ) VALUES (
        v_wid, v_box.product_id, v_box.id, -p_weight,
        'LOSS', 'manual', v_id,
        '박스 폐기(' || v_label || ')' || COALESCE(' — ' || v_note, ''),
        auth.uid()
    );

    PERFORM public.recalc_product_stock(v_box.product_id);

    IF v_box.purchase_unit_price IS NOT NULL THEN
        v_loss := round(p_weight * v_box.purchase_unit_price, 0);
    END IF;

    SELECT p.name INTO v_name FROM public.products p WHERE p.id = v_box.product_id;

    INSERT INTO public.box_disposals (
        id, wholesaler_id, inbound_scan_id, product_id, trace_no, product_name,
        reason_code, note, weight, before_remaining, after_remaining, unit_price, loss_amount, disposed_by
    ) VALUES (
        v_id, v_wid, v_box.id, v_box.product_id, v_box.trace_no, v_name,
        p_reason_code, v_note, p_weight, v_box.remaining_weight, v_after, v_box.purchase_unit_price, v_loss, auth.uid()
    );

    RETURN jsonb_build_object('id', v_id, 'weight', p_weight, 'remaining', v_after, 'loss_amount', v_loss);
END;
$$;

-- 최근 폐기 이력(대표 전용, 자기 업체만)
CREATE FUNCTION public.list_box_disposals(p_limit integer DEFAULT 30)
RETURNS TABLE (
    id uuid, trace_no text, product_name text, reason_code text, note text,
    weight numeric, after_remaining numeric, unit_price numeric, loss_amount numeric,
    disposed_by_name text, created_at timestamptz
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
    SELECT d.id, d.trace_no, d.product_name, d.reason_code, d.note,
           d.weight, d.after_remaining, d.unit_price, d.loss_amount,
           COALESCE(pr.name, '알 수 없음')::text, d.created_at
    FROM public.box_disposals d
    LEFT JOIN public.profiles pr ON pr.id = d.disposed_by
    WHERE d.wholesaler_id = v_wid
    ORDER BY d.created_at DESC, d.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 200);
END;
$$;

REVOKE ALL ON FUNCTION public.dispose_box(uuid, numeric, text, text, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_box_disposals(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispose_box(uuid, numeric, text, text, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_box_disposals(integer) TO authenticated, service_role;
