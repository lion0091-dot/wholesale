-- 명세서 줄에 묶음(로트)번호 칸 추가 — 이력번호와 나란히 두 칸으로 오는 서식 대응 (2026-09-25)
--
-- 배경: 공급처 명세서가 번호를 적는 방식은 하나가 아니다. 이력번호만, 묶음번호만(로트 단위 거래 —
-- 이미 trace_no에 그대로 들어간다), 그리고 **묶음번호 열과 개체번호 열이 나란히** 오는 서식이 있다.
-- 지금까지 파서는 칸 하나(traceNo)만 받아서 두 칸 서식에서는 한 칸이 버려졌고, "이 개체가 정말 그
-- 로트의 구성원인지"도 대조할 수 없었다.
--
-- 잠긴 결정은 그대로다: 묶음번호만 있는 명세서는 trace_no에 들어간다(재고 단위 = 로트). lot_no는 두 칸이
-- 같이 올 때만 채워지며, 서버 사전조회(document-actions.ts)가 로트 조회 결과의 구성원 목록과 개체번호를 대조한다.
--
-- 명세서 줄을 이력번호로 찾는 함수 셋(상품·부위·등급 조회)은 박스 바코드가 개체번호든 로트번호든 걸리도록
-- lot_no도 함께 본다. 같은 로트에 상품·부위가 여럿이면 기존 원칙대로 NULL(되묻는다). 본문은 로컬 DB의
-- pg_get_functiondef 결과(098·113에서 upper() 비교로 바뀐 판)를 기준으로 조건만 넓혔다.

ALTER TABLE public.inbound_document_lines
    ADD COLUMN IF NOT EXISTS lot_no TEXT;

COMMENT ON COLUMN public.inbound_document_lines.lot_no IS
    '묶음(로트)번호. 이력번호(trace_no)와 두 칸으로 나란히 오는 명세서에서만 채워진다. 묶음번호만 적는 명세서는 trace_no에 들어간다.';

CREATE INDEX IF NOT EXISTS idx_inbound_document_lines_lot_no
    ON public.inbound_document_lines (lot_no)
    WHERE lot_no IS NOT NULL;


CREATE OR REPLACE FUNCTION public.lookup_product_by_document_trace(p_trace_no text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_product_id    UUID;
    v_distinct      INT;
    v_trace_no      TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RETURN NULL;
    END IF;

    v_trace_no := upper(btrim(p_trace_no));

    SELECT count(DISTINCT l.product_id) INTO v_distinct
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    JOIN public.products p          ON p.id = l.product_id
    WHERE d.wholesaler_id = v_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND (upper(l.trace_no) = v_trace_no OR upper(l.lot_no) = v_trace_no)
      AND l.product_id IS NOT NULL
      AND p.wholesaler_id = v_wholesaler_id
      AND p.archived_at IS NULL;

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    SELECT DISTINCT l.product_id INTO v_product_id
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    JOIN public.products p          ON p.id = l.product_id
    WHERE d.wholesaler_id = v_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND (upper(l.trace_no) = v_trace_no OR upper(l.lot_no) = v_trace_no)
      AND l.product_id IS NOT NULL
      AND p.wholesaler_id = v_wholesaler_id
      AND p.archived_at IS NULL;

    RETURN v_product_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.lookup_document_part_name(p_wholesaler_id uuid, p_trace_no text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_distinct INT;
    v_part     TEXT;
    v_trace_no TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN NULL;
    END IF;

    v_trace_no := upper(btrim(p_trace_no));

    SELECT count(DISTINCT l.part_name) INTO v_distinct
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND (upper(l.trace_no) = v_trace_no OR upper(l.lot_no) = v_trace_no)
      AND l.part_name IS NOT NULL
      AND btrim(l.part_name) <> '';

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    SELECT DISTINCT l.part_name INTO v_part
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND (upper(l.trace_no) = v_trace_no OR upper(l.lot_no) = v_trace_no)
      AND l.part_name IS NOT NULL
      AND btrim(l.part_name) <> '';

    RETURN v_part;
END;
$function$;


CREATE OR REPLACE FUNCTION public.lookup_document_grade(p_wholesaler_id uuid, p_trace_no text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_distinct INT;
    v_grade    TEXT;
    v_trace_no TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN NULL;
    END IF;

    v_trace_no := upper(btrim(p_trace_no));

    SELECT count(DISTINCT btrim(l.grade)) INTO v_distinct
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND (upper(l.trace_no) = v_trace_no OR upper(l.lot_no) = v_trace_no)
      AND l.grade IS NOT NULL
      AND btrim(l.grade) <> '';

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    SELECT DISTINCT btrim(l.grade) INTO v_grade
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND (upper(l.trace_no) = v_trace_no OR upper(l.lot_no) = v_trace_no)
      AND l.grade IS NOT NULL
      AND btrim(l.grade) <> '';

    RETURN v_grade;
END;
$function$;

-- 권한은 기존 그대로(CREATE OR REPLACE는 GRANT를 유지한다): 상품·부위 조회는 authenticated, 등급 조회는 내부 전용(113).
