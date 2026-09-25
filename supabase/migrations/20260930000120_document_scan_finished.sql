-- 현장 "스캔 종료" 표시 — 사무실이 "현장이 다 찍었다"는 걸 알 수 있게 한다 (2026-09-25)
--
-- 박스가 명세서 수량만큼 끝내 다 안 오는 경우(공급처 결품)에는 "남은 박스가 0"이 영영 안 돼서 사무실이
-- 언제까지 기다릴지 알 수 없었다. 현장이 "여기까지 왔다"고 표시하면 사무실 카드가 "확인·마감하기"로 바뀐다.
-- 재고·대조·마감 규칙은 건드리지 않는다 — 표시만 남기는 열 두 개와, 표시/해제 함수 하나.
--
-- 권한은 close_inbound_document(118)와 같다: 그 명세서 업체에 접근할 수 있는 사람(사장·직원 포함)이면 된다.
-- 대기(PENDING) 명세서에만 표시할 수 있고, 마감(CLOSED)·취소 명세서는 조용히 건너뛴다.

ALTER TABLE public.inbound_documents
    ADD COLUMN IF NOT EXISTS scan_finished_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS scan_finished_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.inbound_documents.scan_finished_at IS
    '현장이 "이 명세서의 스캔을 끝냈다"고 표시한 시각. NULL이면 스캔 중. 재고·대조와 무관한 표시일 뿐이다.';

CREATE OR REPLACE FUNCTION public.set_documents_scan_finished(p_document_ids uuid[], p_finished boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_doc     public.inbound_documents%ROWTYPE;
    v_id      uuid;
    v_changed integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'NOT_AUTHENTICATED';
    END IF;

    FOREACH v_id IN ARRAY COALESCE(p_document_ids, ARRAY[]::uuid[])
    LOOP
        SELECT * INTO v_doc FROM public.inbound_documents WHERE id = v_id;

        -- 남의 업체 명세서는 존재 여부도 알리지 않는다.
        IF v_doc.id IS NULL OR NOT public.can_access_wholesaler(v_doc.wholesaler_id) THEN
            RAISE EXCEPTION 'DOCUMENT_NOT_FOUND';
        END IF;

        IF v_doc.status <> 'PENDING' THEN
            CONTINUE;
        END IF;

        UPDATE public.inbound_documents
        SET scan_finished_at = CASE WHEN p_finished THEN now() ELSE NULL END,
            scan_finished_by = CASE WHEN p_finished THEN auth.uid() ELSE NULL END
        WHERE id = v_id;

        v_changed := v_changed + 1;
    END LOOP;

    RETURN v_changed;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.set_documents_scan_finished(uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_documents_scan_finished(uuid[], boolean) TO authenticated;

COMMENT ON FUNCTION public.set_documents_scan_finished(uuid[], boolean) IS
    '현장 스캔 종료 표시/해제. PENDING 명세서만, 업체 접근 권한 필요. 표시일 뿐 재고·대조에는 영향이 없다.';
