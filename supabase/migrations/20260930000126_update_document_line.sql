-- 대조 중인 전표의 줄 내용을 정식으로 고친다. (사장님 2026-09-26: "만들자")
--
-- 125에서 전표 줄의 직접 수정을 막았으므로, 오타(수량·무게·번호·부위·상품 등)를 바로잡을 수 있는 유일한 길을 함수로 만든다.
-- 전표는 매입 증빙이라 "몰래 바꾸기"가 아니라 누가·언제·무엇을 어떻게 바꿨는지 기록이 남아야 한다 → 수정 기록 표.
--
-- 규칙:
--   · 대조 중(PENDING) 전표의 줄만. 마감된 전표는 먼저 다시 열어야 한다.
--   · 그 업체의 직원이면 누구나(사장·매니저·직원). 기록이 남는다.
--   · 번호(이력번호·묶음번호)를 바꾸면 그 줄에 이어졌던 박스를 풀고(번호가 달라졌으니 다시 맞춰야 한다) 사전조회를 다시 대기시킨다.
--     앱이 이어서 박스를 다시 이어 주고 마감을 검사한다. 수량·무게를 바꾸면 도착 판정은 저절로 다시 계산된다(저장하지 않는 값).
--   · 재고는 건드리지 않는다(잠긴 결정 — 재고는 스캔이 만든다).

CREATE TABLE IF NOT EXISTS public.inbound_document_line_edits (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_id       UUID NOT NULL REFERENCES public.inbound_document_lines(id) ON DELETE CASCADE,
    document_id   UUID NOT NULL REFERENCES public.inbound_documents(id) ON DELETE CASCADE,
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    edited_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    edited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason        TEXT,
    old_values    JSONB NOT NULL,
    new_values    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_document_line_edits_document ON public.inbound_document_line_edits (document_id, edited_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_document_line_edits_line ON public.inbound_document_line_edits (line_id, edited_at DESC);

COMMENT ON TABLE public.inbound_document_line_edits IS
    '전표 줄 수정 기록(바뀐 컬럼의 옛값·새값). 쓰기는 update_inbound_document_line 함수로만. 전표를 완전 삭제하면 함께 지워진다.';

ALTER TABLE public.inbound_document_line_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Document line edits viewable with their wholesaler" ON public.inbound_document_line_edits;

CREATE POLICY "Document line edits viewable with their wholesaler"
ON public.inbound_document_line_edits FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

REVOKE INSERT, UPDATE, DELETE ON public.inbound_document_line_edits FROM authenticated, anon;


CREATE OR REPLACE FUNCTION public.update_inbound_document_line(p_line_id uuid, p_patch jsonb, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_line      public.inbound_document_lines%ROWTYPE;
    v_doc       public.inbound_documents%ROWTYPE;
    v_new       public.inbound_document_lines%ROWTYPE;
    v_old_json  JSONB := '{}'::jsonb;
    v_new_json  JSONB := '{}'::jsonb;
    v_key       TEXT;
    v_text      TEXT;
    v_number    NUMERIC;
    v_product   UUID;
    v_fields    TEXT[] := ARRAY['item_name', 'part_name', 'grade', 'origin', 'trace_no', 'lot_no',
                                'quantity', 'labeled_weight', 'unit_price', 'amount', 'product_id'];
    v_number_changed BOOLEAN := false;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'INVALID_PATCH';
    END IF;

    FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
        IF NOT (v_key = ANY (v_fields)) THEN
            RAISE EXCEPTION 'INVALID_PATCH_FIELD:%', v_key;
        END IF;
    END LOOP;

    SELECT * INTO v_line FROM public.inbound_document_lines WHERE id = p_line_id FOR UPDATE;

    IF v_line.id IS NULL THEN
        RAISE EXCEPTION 'DOCUMENT_LINE_NOT_FOUND';
    END IF;

    SELECT * INTO v_doc FROM public.inbound_documents WHERE id = v_line.document_id;

    IF v_doc.id IS NULL OR NOT public.can_access_wholesaler(v_doc.wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF v_doc.status <> 'PENDING' THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_PENDING';
    END IF;

    v_new := v_line;

    -- 글자 칸: 앞뒤 공백 제거, 빈 값은 비움. 번호 칸은 대문자로(저장 때와 같은 정규화).
    FOREACH v_key IN ARRAY ARRAY['item_name', 'part_name', 'grade', 'origin', 'trace_no', 'lot_no'] LOOP
        IF p_patch ? v_key THEN
            v_text := NULLIF(btrim(COALESCE(p_patch ->> v_key, '')), '');

            IF v_key IN ('trace_no', 'lot_no') AND v_text IS NOT NULL THEN
                v_text := upper(v_text);
            END IF;

            CASE v_key
                WHEN 'item_name' THEN v_new.item_name := v_text;
                WHEN 'part_name' THEN v_new.part_name := v_text;
                WHEN 'grade'     THEN v_new.grade := v_text;
                WHEN 'origin'    THEN v_new.origin := v_text;
                WHEN 'trace_no'  THEN v_new.trace_no := v_text;
                WHEN 'lot_no'    THEN v_new.lot_no := v_text;
            END CASE;
        END IF;
    END LOOP;

    -- 숫자 칸: 수량·표기중량은 0보다 커야 하고 단가·금액은 0 이상. 빈 값은 비움.
    FOREACH v_key IN ARRAY ARRAY['quantity', 'labeled_weight', 'unit_price', 'amount'] LOOP
        IF p_patch ? v_key THEN
            v_number := CASE WHEN jsonb_typeof(p_patch -> v_key) = 'null' THEN NULL ELSE (p_patch ->> v_key)::numeric END;

            IF v_number IS NOT NULL AND (
                (v_key IN ('quantity', 'labeled_weight') AND v_number <= 0)
                OR (v_key IN ('unit_price', 'amount') AND v_number < 0)
            ) THEN
                RAISE EXCEPTION 'INVALID_NUMBER:%', v_key;
            END IF;

            CASE v_key
                WHEN 'quantity'       THEN v_new.quantity := v_number;
                WHEN 'labeled_weight' THEN v_new.labeled_weight := v_number;
                WHEN 'unit_price'     THEN v_new.unit_price := v_number;
                WHEN 'amount'         THEN v_new.amount := v_number;
            END CASE;
        END IF;
    END LOOP;

    IF p_patch ? 'product_id' THEN
        v_product := CASE WHEN jsonb_typeof(p_patch -> 'product_id') = 'null' THEN NULL ELSE (p_patch ->> 'product_id')::uuid END;

        IF v_product IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.products WHERE id = v_product AND wholesaler_id = v_doc.wholesaler_id
        ) THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
        END IF;

        v_new.product_id := v_product;
    END IF;

    -- 실제로 달라진 칸만 기록한다.
    FOREACH v_key IN ARRAY v_fields LOOP
        IF to_jsonb(v_new) -> v_key IS DISTINCT FROM to_jsonb(v_line) -> v_key THEN
            v_old_json := v_old_json || jsonb_build_object(v_key, to_jsonb(v_line) -> v_key);
            v_new_json := v_new_json || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
        END IF;
    END LOOP;

    IF v_new_json = '{}'::jsonb THEN
        RETURN jsonb_build_object('changed', false, 'changed_fields', '[]'::jsonb, 'number_changed', false);
    END IF;

    v_number_changed := v_new_json ? 'trace_no' OR v_new_json ? 'lot_no';

    UPDATE public.inbound_document_lines
    SET item_name = v_new.item_name, part_name = v_new.part_name, grade = v_new.grade, origin = v_new.origin,
        trace_no = v_new.trace_no, lot_no = v_new.lot_no, quantity = v_new.quantity,
        labeled_weight = v_new.labeled_weight, unit_price = v_new.unit_price, amount = v_new.amount,
        product_id = v_new.product_id,
        -- 번호가 바뀌면 그 번호를 이력조회로 다시 확인해야 한다.
        prelookup_status = CASE WHEN v_number_changed AND (v_new.trace_no IS NOT NULL OR v_new.lot_no IS NOT NULL) THEN 'PENDING'
                                WHEN v_number_changed THEN NULL
                                ELSE prelookup_status END,
        prelookup_error = CASE WHEN v_number_changed THEN NULL ELSE prelookup_error END
    WHERE id = p_line_id;

    -- 번호가 달라졌으면 옛 번호로 이어졌던 박스는 이 줄의 것이 아닐 수 있다 — 풀고 앱이 새 번호로 다시 맞춘다.
    IF v_number_changed THEN
        DELETE FROM public.inbound_document_line_scans WHERE line_id = p_line_id;
    END IF;

    INSERT INTO public.inbound_document_line_edits (line_id, document_id, wholesaler_id, edited_by, reason, old_values, new_values)
    VALUES (p_line_id, v_line.document_id, v_doc.wholesaler_id, auth.uid(), NULLIF(btrim(COALESCE(p_reason, '')), ''), v_old_json, v_new_json);

    RETURN jsonb_build_object(
        'changed', true,
        'changed_fields', (SELECT COALESCE(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(v_new_json) AS k),
        'number_changed', v_number_changed
    );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.update_inbound_document_line(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_inbound_document_line(uuid, jsonb, text) TO authenticated;
