-- 명세서 "안 들어온 품목" 판정에서 취소(VOIDED)된 박스를 제외한다 (2026-09-25)
--
-- list_awaiting_document_line_ids()는 번호가 같은 스캔이 하나라도 있으면 그 줄을 "이미 만났다"고 보고 목록에서
-- 뺐다. 잘못 찍어 취소한 박스도 스캔 행이 남아 있어서, 취소했는데도 그 줄이 "안 들어온 품목"에 안 뜨고
-- 입고 화면 카드의 품목 수가 하나 모자랐다. 취소한 박스는 오지 않은 것과 같으므로 세 판정(같은 번호 /
-- 로트 구성원 / 로트 번호로 찍힌 박스) 모두 VOIDED를 제외한다. 본문은 라이브 pg_get_functiondef(116판)를
-- 그대로 옮기고 VOIDED 조건만 더했다. 시그니처·권한·반환 형식은 그대로다.

CREATE OR REPLACE FUNCTION public.list_awaiting_document_line_ids(p_wholesaler_id uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH lines AS (
        SELECT l.id, upper(l.trace_no) AS t, upper(l.lot_no) AS lo
        FROM public.inbound_document_lines l
        JOIN public.inbound_documents d ON d.id = l.document_id
        WHERE d.wholesaler_id = p_wholesaler_id
          AND d.status = 'PENDING'
          AND (l.trace_no IS NOT NULL OR l.lot_no IS NOT NULL)
    ),
    -- 줄에 적힌 로트의 구성원(줄 수만큼만 읽는다)
    line_members AS (
        SELECT id, unnest(public.lot_member_trace_nos(t) || public.lot_member_trace_nos(lo)) AS m
        FROM lines
    ),
    -- 로트 번호로 찍힌 박스들의 구성원(로트 형식인 스캔만, 취소된 박스 제외)
    scan_lots AS (
        SELECT DISTINCT upper(s.trace_no) AS t, public.lot_member_trace_nos(s.trace_no) AS ms
        FROM public.inbound_scans s
        WHERE s.wholesaler_id = p_wholesaler_id
          AND s.status <> 'VOIDED'
          AND s.trace_no ~ '^[Ll]\d{14}$|^\d{15}$'
    )
    SELECT l.id
    FROM lines l
    WHERE NOT EXISTS (
            SELECT 1 FROM public.inbound_scans s
            WHERE s.wholesaler_id = p_wholesaler_id
              AND s.status <> 'VOIDED'
              AND upper(s.trace_no) IN (l.t, l.lo)
          )
      AND NOT EXISTS (
            SELECT 1
            FROM line_members lm
            JOIN public.inbound_scans s ON upper(s.trace_no) = lm.m
            WHERE lm.id = l.id
              AND s.wholesaler_id = p_wholesaler_id
              AND s.status <> 'VOIDED'
          )
      AND NOT EXISTS (
            SELECT 1 FROM scan_lots sl WHERE l.t = ANY (sl.ms)
          );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.list_awaiting_document_line_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_awaiting_document_line_ids(uuid) TO authenticated;
