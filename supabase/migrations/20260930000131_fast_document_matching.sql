-- 전표 대조 화면과 입고 화면이 부르는 두 조회 함수를 큰 데이터에서도 빠르게 다시 짠다. (조회 전용, 결과 규칙은 그대로)
--
-- 부하 측정(전표 줄 9,000개·박스 3,000개):
--   match_document_lines_for_traces  박스 번호 300개 → 36초   (번호마다 document_lines_matching_trace를 불러 전체 줄을 훑었다)
--   list_awaiting_document_line_ids  → 530ms                  (줄마다 박스 전체를 upper()로 훑었다)
-- 둘 다 번호 목록을 한 번에 조인하는 방식으로 바꾼다. 일치 규칙은 document_lines_matching_trace와 같다:
--   같음 / 찍힌 번호가 로트이고 줄의 개체번호가 그 구성원 / 줄의 번호(trace_no·lot_no)가 로트이고 찍힌 개체번호가 그 구성원.

CREATE OR REPLACE FUNCTION public.match_document_lines_for_traces(p_wholesaler_id uuid, p_trace_nos text[])
 RETURNS TABLE(scanned_trace_no text, trace_no text, lot_no text, item_name text, grade text, origin text, unit_price numeric, labeled_weight numeric, supplier_name text, line_no integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH t AS MATERIALIZED (
        SELECT DISTINCT x.scanned AS sraw, upper(btrim(x.scanned)) AS tn
        FROM unnest(COALESCE(p_trace_nos, '{}'::text[])) AS x(scanned)
        WHERE x.scanned IS NOT NULL AND btrim(x.scanned) <> ''
    ),
    -- 찍힌 번호가 로트면 구성원(개체번호)을 한 번씩만 읽는다.
    t_members AS MATERIALIZED (
        SELECT t.sraw AS mraw, unnest(public.lot_member_trace_nos(t.tn)) AS member
        FROM t
        WHERE t.tn ~ '^[Ll]\d{14}$|^\d{15}$'
    ),
    doc_lines AS MATERIALIZED (
        SELECT l.id AS lid, upper(l.trace_no) AS ut, upper(l.lot_no) AS ul, l.trace_no AS ltrace, l.lot_no AS llot,
               l.item_name AS litem, l.grade AS lgrade, l.origin AS lorigin, l.unit_price AS lprice,
               l.labeled_weight AS lweight, l.line_no AS lno, d.supplier_name AS lsupplier, d.created_at AS lcreated
        FROM public.inbound_document_lines l
        JOIN public.inbound_documents d ON d.id = l.document_id
        WHERE d.wholesaler_id = p_wholesaler_id AND d.status <> 'DISCARDED'
    ),
    -- 줄의 번호가 로트인 것 — 로트 값마다 구성원을 한 번씩만 읽는다.
    line_lot_values AS MATERIALIZED (
        SELECT DISTINCT v.lotv
        FROM doc_lines dl
        CROSS JOIN LATERAL (VALUES (dl.ltrace), (dl.llot)) AS v(lotv)
        WHERE v.lotv ~ '^[Ll]\d{14}$|^\d{15}$'
    ),
    lot_members AS MATERIALIZED (
        SELECT v.lotv AS lotkey, unnest(public.lot_member_trace_nos(v.lotv)) AS member
        FROM line_lot_values v
    ),
    hits AS (
        SELECT t.sraw AS hraw, dl.lid AS hlid FROM t JOIN doc_lines dl ON dl.ut = t.tn
        UNION
        SELECT t.sraw, dl.lid FROM t JOIN doc_lines dl ON dl.ul = t.tn
        UNION
        SELECT tm.mraw, dl.lid FROM t_members tm JOIN doc_lines dl ON dl.ut = tm.member
        UNION
        SELECT t.sraw, dl.lid
        FROM lot_members lm
        JOIN doc_lines dl ON (dl.ltrace = lm.lotkey OR dl.llot = lm.lotkey)
        JOIN t ON t.tn = lm.member
    )
    SELECT h.hraw, dl.ltrace, dl.llot, dl.litem, dl.lgrade, dl.lorigin, dl.lprice, dl.lweight, dl.lsupplier, dl.lno
    FROM hits h
    JOIN doc_lines dl ON dl.lid = h.hlid
    ORDER BY h.hraw, dl.lcreated, dl.lno;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.match_document_lines_for_traces(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_document_lines_for_traces(uuid, text[]) TO authenticated;


CREATE OR REPLACE FUNCTION public.list_awaiting_document_line_ids(p_wholesaler_id uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH lines AS MATERIALIZED (
        SELECT l.id AS lid, upper(l.trace_no) AS t, upper(l.lot_no) AS lo
        FROM public.inbound_document_lines l
        JOIN public.inbound_documents d ON d.id = l.document_id
        WHERE d.wholesaler_id = p_wholesaler_id
          AND d.status = 'PENDING'
          AND (l.trace_no IS NOT NULL OR l.lot_no IS NOT NULL)
    ),
    -- 이 업체의 (취소 아닌) 박스 번호 집합 — 줄마다 박스 전체를 다시 훑지 않게 한 번만 만든다.
    scan_keys AS MATERIALIZED (
        SELECT DISTINCT upper(s.trace_no) AS k
        FROM public.inbound_scans s
        WHERE s.wholesaler_id = p_wholesaler_id AND s.status <> 'VOIDED'
    ),
    line_members AS MATERIALIZED (
        SELECT l.lid AS mlid, unnest(public.lot_member_trace_nos(l.t) || public.lot_member_trace_nos(l.lo)) AS m
        FROM lines l
    ),
    scan_lots AS MATERIALIZED (
        SELECT public.lot_member_trace_nos(k.k) AS ms
        FROM scan_keys k
        WHERE k.k ~ '^[Ll]\d{14}$|^\d{15}$'
    )
    SELECT l.lid
    FROM lines l
    WHERE NOT COALESCE(l.t IN (SELECT k FROM scan_keys), false)
      AND NOT COALESCE(l.lo IN (SELECT k FROM scan_keys), false)
      AND NOT EXISTS (
            SELECT 1 FROM line_members lm
            WHERE lm.mlid = l.lid AND lm.m IN (SELECT k FROM scan_keys)
          )
      AND NOT EXISTS (
            SELECT 1 FROM scan_lots sl WHERE l.t = ANY (sl.ms)
          );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.list_awaiting_document_line_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_awaiting_document_line_ids(uuid) TO authenticated;
