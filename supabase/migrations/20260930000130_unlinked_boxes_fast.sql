-- 129의 "안 이어진 박스" 조회가 데이터가 많으면 심하게 느렸다(줄 5,000개·안 이어진 박스 1,500개에서 82초).
-- 원인: 박스마다 document_lines_matching_trace()를 불러 그 업체의 모든 전표 줄을 upper()로 훑었다(인덱스를 못 씀).
-- 이 함수는 종 배지가 30초마다 부르므로 집합 조인으로 다시 짠다. (조회 전용, 데이터 변경 없음)
--   · 대상 박스는 최근 14일 중 안 이어진 것 최신 300개까지.
--   · 번호 일치는 줄의 trace_no/lot_no 인덱스를 쓰는 조인. 로트↔개체 구성원 다리 매칭은 뺐다 —
--     그런 박스는 스캔 때 정상적으로 자동 연결되고, 연결에 실패한 경우의 알림만 못 받는다.
--   · 번호 없는 줄(대기 전표, 아직 안 찬 줄)은 한 번만 모아 두고 박스의 부위와 맞춘다.
--   · CTE는 MATERIALIZED로 고정한다 — 아니면 플래너가 박스마다 다시 계산해 줄별 상태 함수가 수천 번 불린다(측정 7초).

CREATE OR REPLACE FUNCTION public.list_unlinked_boxes_for_documents(p_wholesaler_id uuid)
 RETURNS TABLE (scan_id uuid, document_id uuid, document_status text)
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
    WITH recent AS (
        SELECT s.id AS rid, s.trace_no AS rtrace, s.created_at AS rcreated,
               COALESCE(ml.part_name, p.subcategory) AS rpart
        FROM public.inbound_scans s
        LEFT JOIN public.master_livestock ml ON ml.trace_no = s.trace_no
        LEFT JOIN public.products p ON p.id = s.product_id
        WHERE s.wholesaler_id = p_wholesaler_id
          AND s.status <> 'VOIDED'
          AND s.created_at > now() - interval '14 days'
          AND NOT EXISTS (SELECT 1 FROM public.inbound_document_line_scans x WHERE x.scan_id = s.id)
        ORDER BY s.created_at DESC
        LIMIT 300
    ),
    -- 번호 일치: OR 대신 열마다 따로 조인해야 줄의 trace_no/lot_no 인덱스를 쓴다.
    number_hits AS MATERIALIZED (
        SELECT r.rid AS hid, l.document_id AS hdoc FROM recent r JOIN public.inbound_document_lines l ON l.trace_no = r.rtrace
        UNION ALL
        SELECT r.rid, l.document_id FROM recent r JOIN public.inbound_document_lines l ON l.trace_no = upper(r.rtrace)
        UNION ALL
        SELECT r.rid, l.document_id FROM recent r JOIN public.inbound_document_lines l ON l.lot_no = r.rtrace
        UNION ALL
        SELECT r.rid, l.document_id FROM recent r JOIN public.inbound_document_lines l ON l.lot_no = upper(r.rtrace)
    ),
    by_number AS MATERIALIZED (
        SELECT DISTINCT ON (h.hid) h.hid AS bid, d.id AS bdoc, d.status AS bstatus
        FROM number_hits h
        JOIN public.inbound_documents d
          ON d.id = h.hdoc AND d.wholesaler_id = p_wholesaler_id AND d.status IN ('PENDING', 'CLOSED')
        ORDER BY h.hid, (d.status = 'PENDING') DESC, d.created_at DESC
    ),
    open_numberless AS MATERIALIZED (
        SELECT l.part_name AS opart, d.id AS odoc, d.created_at AS ocreated
        FROM public.inbound_document_lines l
        JOIN public.inbound_documents d ON d.id = l.document_id
        WHERE d.wholesaler_id = p_wholesaler_id
          AND d.status = 'PENDING'
          AND l.trace_no IS NULL AND l.lot_no IS NULL
          AND l.part_name IS NOT NULL
          AND (SELECT x.status FROM public.document_line_match_status(l.id) x) <> 'COMPLETE'
    ),
    by_part AS MATERIALIZED (
        SELECT DISTINCT ON (r.rid) r.rid AS pid, o.odoc AS pdoc
        FROM recent r
        JOIN open_numberless o ON o.opart = r.rpart AND r.rcreated >= o.ocreated - interval '1 day'
        WHERE NOT EXISTS (SELECT 1 FROM by_number b WHERE b.bid = r.rid)
        ORDER BY r.rid, o.ocreated
    )
    SELECT r.rid, COALESCE(b.bdoc, q.pdoc), COALESCE(b.bstatus, 'PENDING')
    FROM recent r
    LEFT JOIN by_number b ON b.bid = r.rid
    LEFT JOIN by_part q ON q.pid = r.rid
    WHERE b.bid IS NOT NULL OR q.pid IS NOT NULL
    ORDER BY r.rcreated DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) IS
    '대기·마감 전표의 줄과 번호가 같거나(번호 있는 줄), 대기 전표의 안 찬 번호 없는 줄과 부위가 같은데 어느 줄에도 안 이어진 최근 14일 박스(최신 300개까지). 사무실 알림·안내 카드용 조회. 로트↔개체 구성원 매칭은 하지 않는다.';
