-- 128의 "안 이어진 박스" 조회에 번호 없는 줄을 더한다. (조회 전용, 데이터 변경 없음)
--
-- 128은 번호가 맞는 박스만 잡았다. 번호가 없는 전표 줄(부위·무게로 잇는 줄)에 부위가 같은 박스가 와 있는데
-- 무게 차이·후보 여럿 때문에 자동으로 안 이어지면, 사무실 카드는 여전히 "스캔 중, 기다려 주세요"만 말했다.
-- 추가 조건: 대기 전표에 아직 다 안 온 번호 없는 줄(번호·묶음번호 없음)이 있고, 박스의 부위(이력 캐시 → 없으면 상품 부위)가
--            그 줄의 부위와 같으며, 박스가 그 전표를 올린 날(하루 전부터) 이후에 찍혔다.
-- 부위가 다른 박스는 그 전표 것인지 알 수 없어 알리지 않는다. 번호가 맞는 박스가 우선이다.

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

    IF NOT EXISTS (
        SELECT 1 FROM public.inbound_documents d
        WHERE d.wholesaler_id = p_wholesaler_id AND d.status IN ('PENDING', 'CLOSED')
    ) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT s.id,
           COALESCE(m.document_id, n.document_id),
           COALESCE(m.document_status, 'PENDING')
    FROM public.inbound_scans s
    LEFT JOIN public.master_livestock ml ON ml.trace_no = s.trace_no
    LEFT JOIN public.products p ON p.id = s.product_id
    LEFT JOIN LATERAL (
        SELECT l.document_id, d.status AS document_status
        FROM public.document_lines_matching_trace(p_wholesaler_id, s.trace_no) l
        JOIN public.inbound_documents d ON d.id = l.document_id
        WHERE d.status IN ('PENDING', 'CLOSED')
        ORDER BY (d.status = 'PENDING') DESC, d.created_at DESC
        LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
        SELECT l.document_id
        FROM public.inbound_document_lines l
        JOIN public.inbound_documents d ON d.id = l.document_id
        WHERE d.wholesaler_id = p_wholesaler_id
          AND d.status = 'PENDING'
          AND l.trace_no IS NULL AND l.lot_no IS NULL
          AND l.part_name IS NOT NULL
          AND l.part_name = COALESCE(ml.part_name, p.subcategory)
          AND s.created_at >= d.created_at - interval '1 day'
          AND (SELECT x.status FROM public.document_line_match_status(l.id) x) <> 'COMPLETE'
        ORDER BY d.created_at
        LIMIT 1
    ) n ON m.document_id IS NULL
    WHERE s.wholesaler_id = p_wholesaler_id
      AND s.status <> 'VOIDED'
      AND s.created_at > now() - interval '14 days'
      AND (m.document_id IS NOT NULL OR n.document_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM public.inbound_document_line_scans x WHERE x.scan_id = s.id)
    ORDER BY s.created_at DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_unlinked_boxes_for_documents(uuid) IS
    '대기·마감 전표의 줄과 번호가 맞거나(번호 있는 줄), 대기 전표의 안 찬 번호 없는 줄과 부위가 같은데 어느 줄에도 안 이어진 최근 14일 박스. 사무실 알림·안내 카드용 조회.';
