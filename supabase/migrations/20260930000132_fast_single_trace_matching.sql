-- 박스 번호 하나에 해당하는 전표 줄을 찾는 document_lines_matching_trace()를 큰 데이터에서도 빠르게 다시 짠다. (조회 전용, 결과 규칙은 그대로)
--
-- 부하 측정(전표 줄 9,700개): 호출 1번 95ms — 줄마다 upper()와 정규식 2개를 계산했고 기존 인덱스(trace_no)는 upper()라 못 썼다.
-- 이 함수는 스캔 기록·부위/등급 조회·자동 연결이 박스 하나에 여러 번 부른다.
-- 표현식 인덱스 2개(upper(trace_no)·upper(lot_no))와 "로트 모양 줄만" 부분 인덱스 2개를 더하고,
-- 일치 조건을 가지별로 나눠 인덱스로 찾는다. 일치 규칙(같음 / 찍힌 게 로트 / 줄이 로트)은 116과 같다.

CREATE INDEX IF NOT EXISTS idx_inbound_document_lines_upper_trace
    ON public.inbound_document_lines (upper(trace_no)) WHERE trace_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_document_lines_upper_lot
    ON public.inbound_document_lines (upper(lot_no)) WHERE lot_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_document_lines_lot_shaped_trace
    ON public.inbound_document_lines (document_id) WHERE trace_no ~ '^[Ll]\d{14}$|^\d{15}$';

CREATE INDEX IF NOT EXISTS idx_inbound_document_lines_lot_shaped_lot
    ON public.inbound_document_lines (document_id) WHERE lot_no ~ '^[Ll]\d{14}$|^\d{15}$';


CREATE OR REPLACE FUNCTION public.document_lines_matching_trace(p_wholesaler_id uuid, p_trace_no text)
 RETURNS SETOF public.inbound_document_lines
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_trace_no      TEXT;
    v_scan_members  TEXT[];
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' OR p_wholesaler_id IS NULL THEN
        RETURN;
    END IF;

    v_trace_no := upper(btrim(p_trace_no));
    -- 찍힌 번호가 로트면 구성원을 한 번만 읽는다(줄마다 다시 읽지 않게).
    v_scan_members := public.lot_member_trace_nos(v_trace_no);

    RETURN QUERY
    WITH docs AS MATERIALIZED (
        SELECT d.id AS did
        FROM public.inbound_documents d
        WHERE d.wholesaler_id = p_wholesaler_id
          AND d.status <> 'DISCARDED'
    ),
    -- 줄의 번호(trace_no·lot_no)가 로트인 값. 값마다 구성원을 한 번씩만 읽는다(형식으로 먼저 걸러 개체번호 줄은 안 뒤진다).
    line_lots AS MATERIALIZED (
        SELECT DISTINCT x.lotv
        FROM (
            SELECT l.trace_no AS lotv
            FROM public.inbound_document_lines l
            JOIN docs ON docs.did = l.document_id
            WHERE l.trace_no ~ '^[Ll]\d{14}$|^\d{15}$'
            UNION ALL
            SELECT l.lot_no
            FROM public.inbound_document_lines l
            JOIN docs ON docs.did = l.document_id
            WHERE l.lot_no ~ '^[Ll]\d{14}$|^\d{15}$'
        ) x
    ),
    -- 원문에 이 번호 글자가 있는 로트만 후보로 좁힌 뒤 정확히 대조한다(좁히기는 상위집합이라 결과는 같다).
    -- MATERIALIZED로 나눠야 플래너가 구성원 읽기(비싼 함수)를 좁히기 앞으로 끌어올리지 못한다.
    lot_candidates AS MATERIALIZED (
        SELECT ll.lotv AS candv
        FROM line_lots ll
        JOIN public.master_livestock m
          ON m.trace_no = upper(btrim(ll.lotv)) AND m.trace_kind = 'group'
        WHERE position(v_trace_no IN upper(m.raw_payload::text)) > 0
    ),
    lot_hit AS MATERIALIZED (
        SELECT c.candv AS hitv
        FROM lot_candidates c
        WHERE v_trace_no = ANY (public.lot_member_trace_nos(c.candv))
    ),
    hits AS (
        SELECT l.id AS hid FROM public.inbound_document_lines l WHERE upper(l.trace_no) = v_trace_no
        UNION
        SELECT l.id FROM public.inbound_document_lines l WHERE upper(l.lot_no) = v_trace_no
        UNION
        SELECT l.id FROM public.inbound_document_lines l WHERE upper(l.trace_no) = ANY (v_scan_members)
        UNION
        SELECT l.id
        FROM lot_hit h
        JOIN public.inbound_document_lines l ON l.trace_no = h.hitv OR l.lot_no = h.hitv
    )
    SELECT l.*
    FROM public.inbound_document_lines l
    JOIN hits ON hits.hid = l.id
    JOIN docs ON docs.did = l.document_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.document_lines_matching_trace(uuid, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.document_lines_matching_trace(uuid, text) IS
    '박스 번호에 해당하는 명세서 줄(같은 번호 + 로트↔개체 구성원 관계). 취소 서류 제외. 내부용 — 호출자가 업체 접근 권한을 확인한다. 인덱스로 찾는다(132).';
