-- 입고 연결 (2026-09-28, 사장님 "ㄱㄱ"): 입고 박스를 "지금 온 거래처"의 열린 발주서와 맞춰 보고, 입고 기준(141)으로 받을지 판정한다.
--
-- 흐름: 스캔에 거래처(supplier_id)가 실려 오면 → 상품이 정해진 뒤 judge_scan_purchase_order가 판정한다.
--   ASSIGNED       : 받았다. 박스 무게를 그 거래처·그 품목의 열린 발주서 줄들에 "오래된 발주서부터" 수량으로 나눠 채운다
--                    (박스가 한 줄에 통째로 붙지 않는다 — 200kg·25kg 발주서에 70+80+77kg 박스가 오면 앞 발주서를 채우고 남은 27kg이 다음 발주서로 간다).
--                    줄이 다 차면 발주서는 자동 마감(auto_closed_at).
--   UNLISTED_HELD  : 발주서에 없는 물건인데 기준이 HOLD — 받아 두고 사무실이 확인한다.
--   OVER_HELD      : 초과(받은 양 + 박스 > 열린 발주 합계 + 허용 오차)인데 기준(over_item_policy)이 HOLD — 받아서 재고에 넣고(팔 수 있다),
--                    발주서 줄에는 남은 자리만큼만 채우고 넘친 무게는 어느 줄에도 붙이지 않는다. 사무실이 확인한다.
--   REJECTED       : 초과(기준 REJECT) 또는 발주서에 없는 물건(기준 REJECT) — 재고에 남기지 않는다.
--                    스캔은 VOIDED로 취소하고, "거절했다"는 사실은 inbound_rejections에 한 줄 남긴다(사장님 결정: 남긴다).
-- 상품이 정해지기 전(PENDING_MAPPING·EXCEPTION)엔 판정하지 않는다. 상품이 정해지는 순간(resolve_inbound_mapping — 자동 생성 포함)에 같은 판정을 한다.
-- 거래처를 안 실은 스캔(엑셀 대량 입고, 옛 호출)은 판정 대상이 아니다 — 기존 동작 그대로.
-- 재고와 판매는 발주서와 무관하다: 받은 박스는 발주서가 덜 찼든 무게가 안 맞든 스캔 즉시 재고가 되어 팔린다(발주서는 받은 양을 세는 장부일 뿐).
--
-- 받은 양은 표를 따로 두지 않고 "줄에 채워진 박스 무게(취소 제외)의 합"으로 센다(파생 값이라 어긋날 자리가 없다).
-- 박스를 취소하면 그 박스의 채움이 사라지고 자동 마감됐던 발주서가 다시 열린다.
-- 이 마이그레이션은 141에서 만든 입고 기준의 "배정 방식"(line_assignment) 설정을 없앤다 — 박스를 줄에 고르는 일이 없어졌다.

-- ------------------------------------------------------------------
-- 스캔에 거래처·판정 상태
-- ------------------------------------------------------------------
ALTER TABLE public.inbound_scans
    ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES public.suppliers(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS po_state TEXT;

ALTER TABLE public.inbound_scans DROP CONSTRAINT IF EXISTS inbound_scans_po_state_check;
ALTER TABLE public.inbound_scans
    ADD CONSTRAINT inbound_scans_po_state_check
    CHECK (po_state IS NULL OR po_state IN ('ASSIGNED', 'UNLISTED_HELD', 'OVER_HELD'));

CREATE INDEX IF NOT EXISTS idx_inbound_scans_supplier
    ON public.inbound_scans (wholesaler_id, supplier_id, created_at DESC)
    WHERE supplier_id IS NOT NULL;

COMMENT ON COLUMN public.inbound_scans.supplier_id IS '이 박스를 가져온 거래처(입고 스캔 화면의 "지금 온 거래처"). 옛 기록·엑셀 입고는 비어 있다.';
COMMENT ON COLUMN public.inbound_scans.po_state IS '발주서 판정 결과: ASSIGNED(발주서 줄들에 채워짐)·UNLISTED_HELD(발주서에 없어 보류)·OVER_HELD(발주 수량 초과라 보류). 판정 전·대상 아님은 NULL.';

-- ------------------------------------------------------------------
-- 박스 → 발주서 줄 채움 (박스 하나가 여러 줄에 나뉘어 채워질 수 있다)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_order_line_scans (
    scan_id       UUID NOT NULL REFERENCES public.inbound_scans(id) ON DELETE CASCADE,
    line_id       UUID NOT NULL REFERENCES public.purchase_order_lines(id) ON DELETE RESTRICT,
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    weight        NUMERIC(10, 3) NOT NULL CHECK (weight > 0),
    linked_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scan_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_line_scans_line ON public.purchase_order_line_scans (line_id);

ALTER TABLE public.purchase_order_line_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "PO line scans viewable by supplier staff" ON public.purchase_order_line_scans;
CREATE POLICY "PO line scans viewable by supplier staff" ON public.purchase_order_line_scans
    FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

COMMENT ON TABLE public.purchase_order_line_scans IS '입고 박스 무게가 발주서 줄들에 어떻게 채워졌는지(박스 하나가 여러 줄에 나뉠 수 있다). 쓰기는 judge_scan_purchase_order 안에서만.';

-- ------------------------------------------------------------------
-- 거절 기록 (재고·입고 기록이 아니라 "받지 않았다"는 사실의 기록)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inbound_rejections (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    supplier_id   UUID NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
    scan_id       UUID REFERENCES public.inbound_scans(id) ON DELETE SET NULL,
    trace_no      TEXT NOT NULL,
    product_id    UUID REFERENCES public.products(id) ON DELETE SET NULL,
    weight        NUMERIC(10, 3) NOT NULL,
    reason        TEXT NOT NULL CHECK (reason IN ('OVER', 'UNLISTED')),
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_rejections_recent ON public.inbound_rejections (wholesaler_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_rejections_trace ON public.inbound_rejections (wholesaler_id, trace_no);

ALTER TABLE public.inbound_rejections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Inbound rejections viewable by supplier staff" ON public.inbound_rejections;
CREATE POLICY "Inbound rejections viewable by supplier staff" ON public.inbound_rejections
    FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

COMMENT ON TABLE public.inbound_rejections IS '발주서 기준(초과·없는 물건)으로 받지 않은 박스의 기록. 재고에는 잡히지 않는다.';
COMMENT ON COLUMN public.inbound_rejections.reason IS 'OVER = 발주 수량(+허용 오차) 초과, UNLISTED = 발주서에 없는 물건.';

-- 입고 기준(141)에 "발주 수량을 넘어 온 박스" 처리 방식 추가: REJECT(받지 않음) / HOLD(일단 받고 사무실 확인). 기본은 기존 동작(REJECT).
ALTER TABLE public.receiving_policies
    ADD COLUMN IF NOT EXISTS over_item_policy TEXT NOT NULL DEFAULT 'REJECT';

ALTER TABLE public.receiving_policies DROP CONSTRAINT IF EXISTS receiving_policies_over_item_policy_check;
ALTER TABLE public.receiving_policies
    ADD CONSTRAINT receiving_policies_over_item_policy_check CHECK (over_item_policy IN ('REJECT', 'HOLD'));

COMMENT ON COLUMN public.receiving_policies.over_item_policy IS '발주 수량(+허용 오차)을 넘어 온 박스: REJECT = 받지 않음(거절 기록), HOLD = 받아서 재고에 넣고 사무실이 확인.';

-- 발주서 자동 마감 표시: 입고로 다 받아서 닫힌 발주서만 취소(박스 취소) 때 다시 열어 준다. 사람이 닫은 발주서는 건드리지 않는다.
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS auto_closed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.purchase_orders.auto_closed_at IS '입고로 모든 줄을 다 받아 자동 마감된 시각. 사람이 닫았거나 열려 있으면 NULL.';

-- ------------------------------------------------------------------
-- 발주서 자동 마감/재개 (내부용)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_purchase_order_completion(p_purchase_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_status    TEXT;
    v_auto      TIMESTAMPTZ;
    v_complete  BOOLEAN;
BEGIN
    SELECT status, auto_closed_at INTO v_status, v_auto
    FROM public.purchase_orders
    WHERE id = p_purchase_order_id
    FOR UPDATE;

    IF v_status IS NULL THEN
        RETURN false;
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.purchase_order_lines WHERE purchase_order_id = p_purchase_order_id)
           AND NOT EXISTS (
               SELECT 1
               FROM public.purchase_order_lines l
               WHERE l.purchase_order_id = p_purchase_order_id
                 AND l.quantity > COALESCE((
                         SELECT sum(x.weight)
                         FROM public.purchase_order_line_scans x
                         JOIN public.inbound_scans s ON s.id = x.scan_id
                         WHERE x.line_id = l.id AND s.status <> 'VOIDED'
                     ), 0)
           )
    INTO v_complete;

    IF v_status = 'OPEN' AND v_complete THEN
        UPDATE public.purchase_orders SET status = 'CLOSED', auto_closed_at = now() WHERE id = p_purchase_order_id;
        RETURN true;
    END IF;

    IF v_status = 'CLOSED' AND v_auto IS NOT NULL AND NOT v_complete THEN
        UPDATE public.purchase_orders SET status = 'OPEN', auto_closed_at = NULL WHERE id = p_purchase_order_id;
        RETURN false;
    END IF;

    RETURN v_status = 'CLOSED';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_purchase_order_completion(UUID) FROM PUBLIC, anon, authenticated;

-- 박스가 취소되면 발주서 줄의 채움에서 빼고(받은 양 감소) 자동 마감됐던 발주서를 다시 연다.
CREATE OR REPLACE FUNCTION public.release_voided_scan_from_purchase_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_pos UUID[];
    v_po  UUID;
BEGIN
    IF NEW.status = 'VOIDED' AND OLD.status <> 'VOIDED' THEN
        SELECT array_agg(DISTINCT l.purchase_order_id) INTO v_pos
        FROM public.purchase_order_line_scans x
        JOIN public.purchase_order_lines l ON l.id = x.line_id
        WHERE x.scan_id = NEW.id;

        IF v_pos IS NOT NULL THEN
            DELETE FROM public.purchase_order_line_scans WHERE scan_id = NEW.id;

            FOREACH v_po IN ARRAY v_pos LOOP
                PERFORM public.refresh_purchase_order_completion(v_po);
            END LOOP;
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.release_voided_scan_from_purchase_order() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_release_voided_scan_from_purchase_order ON public.inbound_scans;
CREATE TRIGGER trg_release_voided_scan_from_purchase_order
    AFTER UPDATE OF status ON public.inbound_scans
    FOR EACH ROW EXECUTE FUNCTION public.release_voided_scan_from_purchase_order();

-- ------------------------------------------------------------------
-- 판정
-- ------------------------------------------------------------------
-- 박스가 채운 줄들의 발주량·받은 양(그 줄들 전체 기준, 이 박스 포함). 화면 문구용 내부 함수.
CREATE OR REPLACE FUNCTION public.purchase_order_scan_progress(p_scan_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT jsonb_build_object(
        'ordered', COALESCE(sum(l.quantity), 0),
        'received', COALESCE(sum(r.received), 0),
        'remaining', GREATEST(COALESCE(sum(l.quantity), 0) - COALESCE(sum(r.received), 0), 0)
    )
    FROM (SELECT DISTINCT line_id FROM public.purchase_order_line_scans WHERE scan_id = p_scan_id) t
    JOIN public.purchase_order_lines l ON l.id = t.line_id
    LEFT JOIN LATERAL (
        SELECT sum(x.weight) AS received
        FROM public.purchase_order_line_scans x
        JOIN public.inbound_scans s ON s.id = x.scan_id
        WHERE x.line_id = l.id AND s.status <> 'VOIDED'
    ) r ON true;
$function$;

REVOKE EXECUTE ON FUNCTION public.purchase_order_scan_progress(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.judge_scan_purchase_order(p_scan_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid      UUID;
    v_scan     public.inbound_scans%ROWTYPE;
    v_policy   public.receiving_policies%ROWTYPE;
    v_mode     TEXT := 'PERCENT';
    v_value    NUMERIC := 0;
    v_unlisted TEXT := 'REJECT';
    v_over     TEXT := 'REJECT';
    v_over_held BOOLEAN := false;
    v_lines    INTEGER;
    v_ordered  NUMERIC;
    v_received NUMERIC;
    v_tol      NUMERIC;
    v_reason   TEXT;
    v_detail   JSONB;
    v_line     RECORD;
    v_left     NUMERIC;
    v_take     NUMERIC;
    v_last     UUID;
    v_pos      UUID[];
    v_po       UUID;
    v_closed   BOOLEAN := false;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();
    IF v_wid IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wid
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    -- 거래처가 없거나 상품이 아직 안 정해졌거나 정상 입고가 아니면 판정하지 않는다.
    IF v_scan.supplier_id IS NULL OR v_scan.product_id IS NULL OR v_scan.status <> 'NORMAL' THEN
        RETURN jsonb_build_object('result', 'SKIPPED');
    END IF;

    -- 멱등: 이미 판정된 박스는 결과만 돌려줄 뿐 다시 세지 않는다.
    IF v_scan.po_state IS NOT NULL THEN
        RETURN jsonb_build_object('result', v_scan.po_state) || public.purchase_order_scan_progress(p_scan_id);
    END IF;

    PERFORM 1 FROM public.products WHERE id = v_scan.product_id FOR UPDATE;

    SELECT * INTO v_policy FROM public.receiving_policies WHERE wholesaler_id = v_wid;
    IF v_policy.wholesaler_id IS NOT NULL THEN
        v_mode := v_policy.over_tolerance_mode;
        v_value := v_policy.over_tolerance_value;
        v_unlisted := v_policy.unlisted_item_policy;
        v_over := v_policy.over_item_policy;
    END IF;

    -- 후보 = 그 거래처의 열린 발주서 중 이 상품 줄 전체를 하나로 묶은 것(발주일 → 작성 시각 → 줄 번호 순).
    WITH cand AS (
        SELECT l.id AS line_id, l.quantity,
               COALESCE((
                   SELECT sum(x.weight)
                   FROM public.purchase_order_line_scans x
                   JOIN public.inbound_scans s ON s.id = x.scan_id
                   WHERE x.line_id = l.id AND s.status <> 'VOIDED'
               ), 0) AS received
        FROM public.purchase_order_lines l
        JOIN public.purchase_orders po ON po.id = l.purchase_order_id
        WHERE po.wholesaler_id = v_wid
          AND po.supplier_id = v_scan.supplier_id
          AND po.status = 'OPEN'
          AND l.product_id = v_scan.product_id
    )
    SELECT count(*), COALESCE(sum(quantity), 0), COALESCE(sum(received), 0)
    INTO v_lines, v_ordered, v_received
    FROM cand;

    v_tol := CASE WHEN v_mode = 'PERCENT' THEN v_ordered * v_value / 100 ELSE v_value END;

    IF v_lines = 0 THEN
        -- 다 받아서 자동 마감된 발주서에 있는 품목이면 "없는 물건"이 아니라 "이미 다 받은 물건이 더 온 것"이다(초과).
        -- 사람이 닫은 발주서는 해당하지 않는다 — 다 받았다는 뜻이 아니므로 없는 물건 기준을 따른다.
        IF EXISTS (
            SELECT 1
            FROM public.purchase_order_lines l
            JOIN public.purchase_orders po ON po.id = l.purchase_order_id
            WHERE po.wholesaler_id = v_wid
              AND po.supplier_id = v_scan.supplier_id
              AND po.status = 'CLOSED'
              AND po.auto_closed_at IS NOT NULL
              AND l.product_id = v_scan.product_id
        ) THEN
            v_reason := 'OVER';
        ELSIF v_unlisted = 'HOLD' THEN
            UPDATE public.inbound_scans SET po_state = 'UNLISTED_HELD' WHERE id = p_scan_id;
            RETURN jsonb_build_object('result', 'UNLISTED_HELD');
        ELSE
            v_reason := 'UNLISTED';
        END IF;
    ELSIF v_received + v_scan.weight > v_ordered + v_tol THEN
        v_reason := 'OVER';
    END IF;

    IF v_reason = 'OVER' AND v_over = 'HOLD' THEN
        v_over_held := true;
        v_reason := NULL;
    END IF;

    IF v_reason IS NOT NULL THEN
        v_detail := jsonb_build_object(
            'ordered', v_ordered, 'received', v_received, 'tolerance', v_tol,
            'tolerance_mode', v_mode, 'tolerance_value', v_value, 'weight', v_scan.weight
        );

        INSERT INTO public.inbound_rejections (wholesaler_id, supplier_id, scan_id, trace_no, product_id, weight, reason, detail)
        VALUES (v_wid, v_scan.supplier_id, p_scan_id, v_scan.trace_no, v_scan.product_id, v_scan.weight, v_reason, v_detail);

        PERFORM public.void_inbound_scan(
            p_scan_id,
            CASE v_reason WHEN 'OVER' THEN '발주 수량 초과로 받지 않음' ELSE '발주서에 없는 품목이라 받지 않음' END
        );

        RETURN jsonb_build_object(
            'result', 'REJECTED', 'reason', v_reason,
            'ordered', v_ordered, 'received', v_received, 'tolerance', v_tol
        );
    END IF;

    -- 받는다. 박스 무게를 자리가 남은 줄부터 차례로 채운다. 허용 오차 안의 초과분은 마지막에 채운 줄(없으면 맨 뒤 줄)에 얹는다.
    v_left := v_scan.weight;

    FOR v_line IN
        SELECT l.id AS line_id, l.quantity - COALESCE((
                   SELECT sum(x.weight)
                   FROM public.purchase_order_line_scans x
                   JOIN public.inbound_scans s ON s.id = x.scan_id
                   WHERE x.line_id = l.id AND s.status <> 'VOIDED'
               ), 0) AS room
        FROM public.purchase_order_lines l
        JOIN public.purchase_orders po ON po.id = l.purchase_order_id
        WHERE po.wholesaler_id = v_wid
          AND po.supplier_id = v_scan.supplier_id
          AND po.status = 'OPEN'
          AND l.product_id = v_scan.product_id
        ORDER BY po.ordered_on, po.created_at, l.line_no, l.id
    LOOP
        EXIT WHEN v_left <= 0;
        CONTINUE WHEN v_line.room <= 0;

        v_take := LEAST(v_line.room, v_left);

        INSERT INTO public.purchase_order_line_scans (scan_id, line_id, wholesaler_id, weight, linked_by)
        VALUES (p_scan_id, v_line.line_id, v_wid, v_take, auth.uid());

        v_left := v_left - v_take;
        v_last := v_line.line_id;
    END LOOP;

    -- 초과를 받아 두는 경우(HOLD)는 남은 자리만 채우고, 넘친 무게는 어느 줄에도 붙이지 않는다.
    IF v_left > 0 AND NOT v_over_held THEN
        IF v_last IS NULL THEN
            SELECT l.id INTO v_last
            FROM public.purchase_order_lines l
            JOIN public.purchase_orders po ON po.id = l.purchase_order_id
            WHERE po.wholesaler_id = v_wid
              AND po.supplier_id = v_scan.supplier_id
              AND po.status = 'OPEN'
              AND l.product_id = v_scan.product_id
            ORDER BY po.ordered_on DESC, po.created_at DESC, l.line_no DESC, l.id DESC
            LIMIT 1;

            INSERT INTO public.purchase_order_line_scans (scan_id, line_id, wholesaler_id, weight, linked_by)
            VALUES (p_scan_id, v_last, v_wid, v_left, auth.uid());
        ELSE
            UPDATE public.purchase_order_line_scans
            SET weight = weight + v_left
            WHERE scan_id = p_scan_id AND line_id = v_last;
        END IF;
    END IF;

    UPDATE public.inbound_scans
    SET po_state = CASE WHEN v_over_held THEN 'OVER_HELD' ELSE 'ASSIGNED' END
    WHERE id = p_scan_id;

    SELECT array_agg(DISTINCT l.purchase_order_id) INTO v_pos
    FROM public.purchase_order_line_scans x
    JOIN public.purchase_order_lines l ON l.id = x.line_id
    WHERE x.scan_id = p_scan_id;

    FOREACH v_po IN ARRAY COALESCE(v_pos, ARRAY[]::UUID[]) LOOP
        IF public.refresh_purchase_order_completion(v_po) THEN
            v_closed := true;
        END IF;
    END LOOP;

    IF v_over_held THEN
        RETURN jsonb_build_object(
            'result', 'OVER_HELD', 'order_closed', v_closed,
            'ordered', v_ordered, 'received', v_received + (v_scan.weight - v_left),
            'remaining', 0, 'tolerance', v_tol, 'excess', v_left
        );
    END IF;

    RETURN jsonb_build_object('result', 'ASSIGNED', 'order_closed', v_closed) || public.purchase_order_scan_progress(p_scan_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.judge_scan_purchase_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.judge_scan_purchase_order(UUID) TO authenticated, service_role;

-- 입고 기준의 "배정 방식" 설정(141)은 더 이상 쓰지 않는다 — 박스가 줄을 고르는 일이 없다.
ALTER TABLE public.receiving_policies DROP COLUMN IF EXISTS line_assignment;

-- ------------------------------------------------------------------
-- record_inbound_scan: 거래처를 받아 판정한다. 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로 패치했다(098의 것에 거래처·판정만 더함).
-- 인자가 늘어 옛 시그니처와 겹치므로 옛 것을 지우고 다시 만든다(권한은 옛 것과 같게 복원).
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_inbound_scan(
    text, numeric, text, uuid, text, uuid, text, boolean, date, numeric, numeric, text, text
);

CREATE OR REPLACE FUNCTION public.record_inbound_scan(
    p_trace_no text, p_weight numeric, p_scan_type text,
    p_product_id uuid DEFAULT NULL::uuid, p_fail_reason text DEFAULT NULL::text,
    p_import_row_id uuid DEFAULT NULL::uuid, p_memo text DEFAULT NULL::text,
    p_confirm_duplicate boolean DEFAULT false, p_best_before date DEFAULT NULL::date,
    p_labeled_weight numeric DEFAULT NULL::numeric, p_purchase_unit_price numeric DEFAULT NULL::numeric,
    p_purchase_supplier text DEFAULT NULL::text, p_fail_detail text DEFAULT NULL::text,
    p_supplier_id uuid DEFAULT NULL::uuid
)
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
       AND NOT public.can_manage_wholesaler(public.resolve_current_wholesaler_id()) THEN
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
        'purchase_unit_price', v_scan.purchase_unit_price,
        'purchase_amount',     v_scan.purchase_amount,
        'purchase_supplier',   v_scan.purchase_supplier
    )
    || CASE
           WHEN v_po IS NULL THEN '{}'::jsonb
           WHEN v_po ->> 'result' = 'REJECTED' THEN jsonb_build_object('status', 'REJECTED', 'po', v_po)
           ELSE jsonb_build_object('po', v_po)
       END;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.record_inbound_scan(
    text, numeric, text, uuid, text, uuid, text, boolean, date, numeric, numeric, text, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_inbound_scan(
    text, numeric, text, uuid, text, uuid, text, boolean, date, numeric, numeric, text, text, uuid
) TO anon, authenticated, service_role;

-- ------------------------------------------------------------------
-- 상품이 나중에 정해지는 경로(사무실 지정·자동 생성): 같은 판정을 한다. 거절이면 status를 REJECTED로 돌려준다.
-- 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로 패치했다(140의 것에 판정만 더함).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping(p_scan_id uuid, p_product_id uuid, p_remember boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_master        public.master_livestock%ROWTYPE;
    v_product_part  TEXT;
    v_po            JSONB;
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

    IF v_scan.status NOT IN ('PENDING_MAPPING', 'EXCEPTION') THEN
        RAISE EXCEPTION 'SCAN_ALREADY_RESOLVED';
    END IF;

    PERFORM 1 FROM public.products
    WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    UPDATE public.inbound_scans
    SET product_id = p_product_id,
        status = 'NORMAL',
        remaining_weight = weight
    WHERE id = p_scan_id;

    PERFORM public.ensure_opening_balance(p_product_id);

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, created_by
    ) VALUES (
        v_wholesaler_id, p_product_id, p_scan_id, v_scan.weight,
        'INBOUND', 'inbound_scan', p_scan_id, auth.uid()
    );

    PERFORM public.recalc_product_stock(p_product_id);

    UPDATE public.livestock_exception_log
    SET resolved_status = 'RESOLVED',
        resolved_by = auth.uid(),
        resolved_at = now()
    WHERE inbound_scan_id = p_scan_id AND resolved_status = 'PENDING';

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_scan.trace_no;
    SELECT subcategory INTO v_product_part FROM public.products WHERE id = p_product_id;

    IF p_remember THEN
        IF v_master.part_name IS NOT NULL AND v_master.species_group IS NOT NULL THEN
            INSERT INTO public.trace_product_map (
                wholesaler_id, species_group, part_name, grade, breed, product_id, created_by
            ) VALUES (
                v_wholesaler_id, v_master.species_group, v_master.part_name,
                v_master.grade, CASE WHEN v_master.species_group = '소' THEN public.trace_breed(v_master.species) END,
                p_product_id, auth.uid()
            )
            ON CONFLICT (wholesaler_id, species_group, part_name, COALESCE(grade, ''), COALESCE(breed, ''))
            DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now();
        END IF;
    END IF;

    IF v_scan.supplier_id IS NOT NULL THEN
        v_po := public.judge_scan_purchase_order(p_scan_id);
    END IF;

    RETURN jsonb_build_object(
        'scan_id', p_scan_id,
        'status', CASE WHEN v_po ->> 'result' = 'REJECTED' THEN 'REJECTED' ELSE 'NORMAL' END,
        'product_id', p_product_id,
        'part_mismatch', public.parts_conflict(v_master.part_name, v_product_part),
        'trace_part', v_master.part_name,
        'product_part', v_product_part
    ) || CASE WHEN v_po IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('po', v_po) END;
END;
$function$;

-- 사무실이 상품을 골라 주문에 바로 출고하는 경로: 거절된 박스는 출고할 게 없으니 출고를 건너뛴다.
CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping_to_order(p_scan_id uuid, p_product_id uuid, p_order_id uuid, p_remember boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_resolve  JSONB;
    v_outbound JSONB;
    v_scan     public.inbound_scans%ROWTYPE;
BEGIN
    v_resolve := public.resolve_inbound_mapping(p_scan_id, p_product_id, p_remember);

    IF v_resolve ->> 'status' = 'REJECTED' THEN
        RETURN jsonb_build_object('resolve', v_resolve, 'outbound', NULL);
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    -- p_weight를 생략(NULL)하면 record_outbound_scan이 "박스 잔량과 주문에 필요한
    -- 양 중 작은 쪽"을 알아서 가져간다 — 방금 들어온 박스가 주문보다 커도 문제없다.
    v_outbound := public.record_outbound_scan(p_order_id, v_scan.trace_no, NULL, p_scan_id);

    RETURN jsonb_build_object('resolve', v_resolve, 'outbound', v_outbound);
END;
$function$;

-- ------------------------------------------------------------------
-- 이력번호를 바로잡거나 다시 조회해 새 박스로 갈아치우는 경로: 거래처를 새 박스로 옮기고, 재고에 들어갔으면 같은 판정을 한다.
-- 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로 패치했다(거래처 옮기기·판정만 더함).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.replace_inbound_scan_trace_no(p_scan_id uuid, p_new_trace_no text, p_fail_reason text DEFAULT NULL::text, p_fail_detail text DEFAULT NULL::text, p_confirm_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_old           public.inbound_scans%ROWTYPE;
    v_new_no        TEXT;
    v_result        JSONB;
    v_new_id        UUID;
    v_new           public.inbound_scans%ROWTYPE;
    v_default       public.product_purchase_prices%ROWTYPE;
    v_po            JSONB;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_old
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id
    FOR UPDATE;

    IF v_old.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_old.status NOT IN ('EXCEPTION', 'PENDING_MAPPING') THEN
        RAISE EXCEPTION 'SCAN_NOT_EDITABLE';
    END IF;

    v_new_no := upper(btrim(COALESCE(p_new_trace_no, '')));

    IF v_new_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    PERFORM public.void_inbound_scan(
        p_scan_id,
        CASE WHEN v_new_no = upper(v_old.trace_no)
             THEN '이력 재조회'
             ELSE '이력번호 정정: ' || v_old.trace_no || ' → ' || v_new_no
        END
    );

    -- 새 번호로 다시 기록한다. 상품 결정(학습된 매핑)·재고 반영·예외 기록은 원래 스캔과 같은 경로다.
    v_result := public.record_inbound_scan_base(
        v_new_no, v_old.weight, v_old.scan_type, NULL,
        p_fail_reason, NULL, v_old.memo, p_confirm_duplicate, p_fail_detail
    );

    v_new_id := NULLIF(v_result ->> 'scan_id', '')::UUID;

    IF v_new_id IS NULL THEN
        RAISE EXCEPTION 'REPLACE_FAILED';
    END IF;

    SELECT * INTO v_new FROM public.inbound_scans WHERE id = v_new_id;

    IF v_new.product_id IS NOT NULL THEN
        SELECT * INTO v_default FROM public.product_purchase_prices WHERE product_id = v_new.product_id;
    END IF;

    UPDATE public.inbound_scans
    SET labeled_weight              = v_old.labeled_weight,
        best_before                 = v_old.best_before,
        purchase_unit_price         = COALESCE(v_old.purchase_unit_price, v_default.unit_price),
        purchase_supplier           = COALESCE(v_old.purchase_supplier, v_default.supplier_name),
        gtin                        = v_old.gtin,
        storage_location            = v_old.storage_location,
        storage_location_photo_path = v_old.storage_location_photo_path,
        unit                        = v_old.unit,
        scanned_by                  = v_old.scanned_by,
        created_at                  = v_old.created_at,
        supplier_id                 = v_old.supplier_id
    WHERE id = v_new_id;

    IF v_old.supplier_id IS NOT NULL AND v_new.status = 'NORMAL' THEN
        v_po := public.judge_scan_purchase_order(v_new_id);
    END IF;

    RETURN v_result
        || jsonb_build_object('old_scan_id', p_scan_id)
        || CASE
               WHEN v_po IS NULL THEN '{}'::jsonb
               WHEN v_po ->> 'result' = 'REJECTED' THEN jsonb_build_object('status', 'REJECTED', 'po', v_po)
               ELSE jsonb_build_object('po', v_po)
           END;
END;
$function$;
