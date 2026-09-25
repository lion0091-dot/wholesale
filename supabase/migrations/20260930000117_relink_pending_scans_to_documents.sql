-- 스캔 먼저·명세서 나중 — 명세서를 올리면 이미 찍혀 있던 상품 미확정 박스를 거슬러 확정한다 (2026-09-25)
--
-- 명세서 줄의 상품(사람이 지목한 값)은 박스를 찍는 순간에만 쓰였다(record_inbound_scan 직전
-- lookup_product_by_document_trace). 박스가 먼저 오고 명세서가 뒤에 올라오면 그 박스들은 "상품 확인 필요"
-- (PENDING_MAPPING) 또는 이력 조회 실패(EXCEPTION)로 남았고, 사람이 목록에서 하나씩 지정해야 했다.
-- 명세서 서류가 먼저 올 수도, 창고 스캔이 먼저일 수도 있다는 원칙(document-requirements.ts 머리말)에 맞춰
-- 반대 순서도 같은 결과가 나오게 한다.
--
-- 판정은 스캔 시점과 똑같이 lookup_product_by_document_trace()에 맡긴다 — 로트↔개체 다리(116) 포함,
-- 서로 다른 상품이 걸리면 NULL(되묻는다). 확정은 사람이 목록에서 상품을 고를 때 쓰는 resolve_inbound_mapping()
-- 그대로(재고 원장·예외 로그 처리·학습 매핑 동일). 명세서 저장 직후 서버 액션이 부른다.

CREATE OR REPLACE FUNCTION public.relink_pending_scans_to_documents()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_scan          RECORD;
    v_product_id    UUID;
    v_linked        JSONB := '[]'::jsonb;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    FOR v_scan IN
        SELECT s.id, s.trace_no
        FROM public.inbound_scans s
        WHERE s.wholesaler_id = v_wholesaler_id
          AND s.status IN ('PENDING_MAPPING', 'EXCEPTION')
          AND s.product_id IS NULL
        ORDER BY s.created_at
    LOOP
        v_product_id := public.lookup_product_by_document_trace(v_scan.trace_no);

        IF v_product_id IS NULL THEN
            CONTINUE;
        END IF;

        PERFORM public.resolve_inbound_mapping(v_scan.id, v_product_id, true);

        v_linked := v_linked || jsonb_build_object(
            'scan_id', v_scan.id,
            'trace_no', v_scan.trace_no,
            'product_id', v_product_id,
            'product_name', (SELECT name FROM public.products WHERE id = v_product_id)
        );
    END LOOP;

    RETURN v_linked;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.relink_pending_scans_to_documents() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.relink_pending_scans_to_documents() TO authenticated;

COMMENT ON FUNCTION public.relink_pending_scans_to_documents() IS
    '상품 미확정·예외 박스 중 명세서 줄로 상품이 하나로 정해지는 것을 거슬러 확정. 명세서 저장 직후 호출. 확정된 박스 목록(jsonb 배열) 반환.';
