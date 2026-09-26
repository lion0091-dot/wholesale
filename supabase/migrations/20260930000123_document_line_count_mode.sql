-- 전표 줄마다 "다 왔는지"를 무엇으로 세는지 정한다 — 박스 수(BOXES) 또는 무게(WEIGHT). (사장님 2026-09-26)
--
-- 지금까지는 줄의 수량을 박스 수로만 봤다(비우면 1박스). 그런데 전표는 줄마다 단위가 다르다:
--   · 개체번호 한 줄 "10kg" — 그 한 마리가 몇 박스로 나뉘어 오든 무게가 다 왔는지가 기준이다.
--   · 로트번호 한 줄 "3박스" — 박스 수가 기준이다.
-- 그래서 개체번호 줄이 여러 박스로 오면 "더 많이 옴"으로 굳어 자동 마감이 막혔다.
--
-- count_mode NULL = 자동. 아래 document_line_effective_count_mode 규칙으로 정한다(TS 쪽 effectiveCountMode와 같아야 함).
-- 사무실이 줄마다 BOXES/WEIGHT로 고정할 수 있다(set_document_line_count_mode).
-- 재고는 여전히 스캔이 만든다 — 이 판정은 전표 대조·자동 마감용이다.

ALTER TABLE public.inbound_document_lines
    ADD COLUMN IF NOT EXISTS count_mode TEXT CHECK (count_mode IS NULL OR count_mode IN ('BOXES', 'WEIGHT'));

COMMENT ON COLUMN public.inbound_document_lines.count_mode IS
    '도착 판정 기준. NULL=자동(document_line_effective_count_mode), BOXES=박스 수, WEIGHT=표기중량 대비 잰 무게(±inbound_weight_tolerance).';

-- 자동 규칙:
--   표기중량이 없으면 무게로 못 세니 BOXES
--   한 칸에 번호 여럿을 나눈 줄("(이력번호 k/N)")은 합계가 첫 줄에만 있어 BOXES(예전 그대로)
--   개체번호(12자리) 줄은 WEIGHT, 그 밖에는 수량이 없을 때만 WEIGHT, 수량이 있으면 BOXES
CREATE OR REPLACE FUNCTION public.document_line_effective_count_mode(
    p_count_mode text, p_quantity numeric, p_labeled_weight numeric, p_trace_no text, p_raw_text text
) RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN p_labeled_weight IS NULL OR p_labeled_weight <= 0 THEN 'BOXES'
        WHEN p_count_mode IS NOT NULL THEN p_count_mode
        WHEN p_raw_text ~ '\(이력번호 [0-9]+/[0-9]+\)$' THEN 'BOXES'
        WHEN btrim(COALESCE(p_trace_no, '')) ~ '^[0-9]{12}$' THEN 'WEIGHT'
        WHEN p_quantity IS NULL THEN 'WEIGHT'
        ELSE 'BOXES'
    END;
$function$;

REVOKE EXECUTE ON FUNCTION public.document_line_effective_count_mode(text, numeric, numeric, text, text) FROM PUBLIC, anon, authenticated;

-- 반환 열이 늘어 DROP 후 다시 만든다(호출하는 plpgsql 함수들은 열 이름으로만 읽어 그대로 동작).
-- BOXES: expected=예정 박스 수, linked=붙은 박스 수.
-- WEIGHT: 호출하는 쪽(자리 남았나: linked < expected)이 그대로 쓰도록 환산한다 —
--         expected=1, linked = 0(안 왔거나 모자람) / 1(오차 안) / 2(넘침). 실제 무게·박스 수는 뒤 열에 따로 준다.
DROP FUNCTION IF EXISTS public.document_line_match_status(uuid);

CREATE FUNCTION public.document_line_match_status(p_line_id uuid)
 RETURNS TABLE (
    expected integer, linked integer, status text,
    mode text, expected_weight numeric, linked_weight numeric, linked_boxes integer
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    WITH l AS (
        SELECT quantity, labeled_weight,
               public.document_line_effective_count_mode(count_mode, quantity, labeled_weight, trace_no, raw_text) AS mode
        FROM public.inbound_document_lines WHERE id = p_line_id
    ),
    n AS (
        SELECT count(*)::int AS boxes, COALESCE(sum(s.weight), 0) AS wsum
        FROM public.inbound_document_line_scans ls
        JOIN public.inbound_scans s ON s.id = ls.scan_id
        WHERE ls.line_id = p_line_id AND s.status <> 'VOIDED'
    ),
    w AS (
        SELECT l.mode, l.quantity, l.labeled_weight, n.boxes, n.wsum,
               CASE
                   WHEN l.mode <> 'WEIGHT' THEN NULL
                   WHEN n.boxes = 0 THEN 'AWAITING'
                   WHEN n.wsum < l.labeled_weight * (1 - public.inbound_weight_tolerance()) THEN 'PARTIAL'
                   WHEN n.wsum <= l.labeled_weight * (1 + public.inbound_weight_tolerance()) THEN 'COMPLETE'
                   ELSE 'OVER'
               END AS wstatus
        FROM l, n
    )
    SELECT
        CASE WHEN w.mode = 'WEIGHT' THEN 1 ELSE public.document_line_expected_qty(w.quantity) END,
        CASE WHEN w.mode = 'WEIGHT'
             THEN CASE w.wstatus WHEN 'COMPLETE' THEN 1 WHEN 'OVER' THEN 2 ELSE 0 END
             ELSE w.boxes
        END,
        CASE WHEN w.mode = 'WEIGHT' THEN w.wstatus
             WHEN w.boxes = 0 THEN 'AWAITING'
             WHEN w.boxes < public.document_line_expected_qty(w.quantity) THEN 'PARTIAL'
             WHEN w.boxes = public.document_line_expected_qty(w.quantity) THEN 'COMPLETE'
             ELSE 'OVER'
        END,
        w.mode,
        CASE WHEN w.mode = 'WEIGHT' THEN w.labeled_weight END,
        w.wsum,
        w.boxes
    FROM w;
$function$;

REVOKE EXECUTE ON FUNCTION public.document_line_match_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.document_line_match_status(uuid) TO authenticated;


-- 사무실이 줄의 판정 기준을 바꾼다. NULL/'AUTO'는 자동으로 되돌린다. 대조 중(PENDING) 전표만.
CREATE OR REPLACE FUNCTION public.set_document_line_count_mode(p_line_id uuid, p_mode text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_doc    public.inbound_documents%ROWTYPE;
    v_line   public.inbound_document_lines%ROWTYPE;
    v_mode   TEXT;
BEGIN
    v_mode := CASE WHEN p_mode IS NULL OR p_mode = 'AUTO' THEN NULL ELSE p_mode END;

    IF v_mode IS NOT NULL AND v_mode NOT IN ('BOXES', 'WEIGHT') THEN
        RAISE EXCEPTION 'INVALID_COUNT_MODE';
    END IF;

    SELECT * INTO v_line FROM public.inbound_document_lines WHERE id = p_line_id;

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

    IF v_mode = 'WEIGHT' AND (v_line.labeled_weight IS NULL OR v_line.labeled_weight <= 0) THEN
        RAISE EXCEPTION 'NO_LABELED_WEIGHT';
    END IF;

    UPDATE public.inbound_document_lines SET count_mode = v_mode, updated_at = now() WHERE id = p_line_id;

    RETURN public.document_line_effective_count_mode(v_mode, v_line.quantity, v_line.labeled_weight, v_line.trace_no, v_line.raw_text);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.set_document_line_count_mode(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_document_line_count_mode(uuid, text) TO authenticated;
