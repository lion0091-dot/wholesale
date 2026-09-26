-- 전표 번호와 맞는데 어느 줄에도 안 이어진 박스를 사무실이 놓치지 않게 목록으로 돌려준다. (종 배지·전표입력 카드용, 조회만 — 데이터 변경 없음)
--
-- ① 마감(CLOSED)된 전표: 마감된 전표에는 박스를 이을 수 없어서(다시 열기 전까지) 뒤늦게 스캔된 박스가 어느 줄에도 안 이어진 채 남는다.
-- ② 대기(PENDING) 전표: 같은 번호가 대기 전표 두 장에 있으면 자동으로 잇지 않는다(설계). 박스는 이미 왔는데 사무실 카드는
--    "현장에서 스캔 중, 기다려 주세요"라고만 말해 대조 화면으로 데려가지 못했다.
-- 조건: 이 업체의 박스(취소 제외)가 어느 전표 줄에도 안 이어졌고, 번호가 그 전표의 줄과 대응한다.
--       대응 판정은 document_lines_matching_trace(같은 번호 + 로트↔개체 구성원)를 그대로 쓴다.
-- 최근 14일 박스만 본다 — 종 배지가 30초마다 부르므로 범위를 좁히고, 오래된 미연결 박스는 사무실이 이미 판단한 것으로 본다.
-- 한 박스가 대기·마감 전표에 다 맞으면 대기 전표를 돌려준다(사무실이 먼저 볼 곳).

CREATE OR REPLACE FUNCTION public.list_unlinked_boxes_for_documents(p_wholesaler_id uuid)
 RETURNS TABLE (scan_id uuid, document_id uuid, document_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN;
    END IF;

    -- 대기·마감 전표가 하나도 없으면 박스마다 줄을 대조할 필요가 없다.
    IF NOT EXISTS (
        SELECT 1 FROM public.inbound_documents d
        WHERE d.wholesaler_id = p_wholesaler_id AND d.status IN ('PENDING', 'CLOSED')
    ) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT s.id, m.document_id, m.document_status
    FROM public.inbound_scans s
    CROSS JOIN LATERAL (
        SELECT l.document_id, d.status AS document_status
        FROM public.document_lines_matching_trace(p_wholesaler_id, s.trace_no) l
        JOIN public.inbound_documents d ON d.id = l.document_id
        WHERE d.status IN ('PENDING', 'CLOSED')
        ORDER BY (d.status = 'PENDING') DESC, d.created_at DESC
        LIMIT 1
    ) m
    WHERE s.wholesaler_id = p_wholesaler_id
      AND s.status <> 'VOIDED'
      AND s.created_at > now() - interval '14 days'
      AND NOT EXISTS (SELECT 1 FROM public.inbound_document_line_scans x WHERE x.scan_id = s.id)
    ORDER BY s.created_at DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) IS
    '대기·마감 전표의 줄과 번호가 맞는데 어느 줄에도 안 이어진 최근 14일 박스(scan_id)와 그 전표(document_id, document_status). 사무실 알림·안내 카드용 조회.';
