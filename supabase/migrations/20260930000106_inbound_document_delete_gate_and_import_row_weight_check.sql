-- 3번 입고 DB 테스트(scripts/db-test-inbound.sql)에서 나온 정보 2건 — 사장님 결정(2026-09-24)으로 DB에서도 막는다.
--
-- 1) 취소(DISCARDED) 안 한 공급처 명세서는 DB에서도 완전삭제 불가.
--    앱(deleteInboundDocumentAction)은 이미 "먼저 취소 처리" 를 요구하지만, DELETE 정책은
--    owner/manager 여부만 보고 상태는 안 봐서 직접 호출하면 지워졌다. 명세서는 매입 증빙이라
--    축산물이력법상 매입일부터 1년 보관 — 두 단계(취소 → 삭제)를 DB 규칙으로 못 박는다.
--    서버(service_role)·RPC 내부·super_admin 세션은 통과(enforce_wholesaler_platform_columns와 같은 기준)
--    — 공급사 행 삭제 시 CASCADE, 관리자 정리 작업이 막히지 않게.
--
-- 2) 엑셀 대량 입고 행(inbound_import_rows.weight)에 CHECK(> 0).
--    앱(createImportJobAction)이 weight > 0 으로 거르지만 DB에는 제약이 없어 0/음수 행이 저장될 수
--    있었다(실패 처리는 record_inbound_scan의 INVALID_WEIGHT에만 기대던 상태).

CREATE OR REPLACE FUNCTION public.enforce_inbound_document_discarded_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    -- 서비스 키·크론·SECURITY DEFINER RPC 내부(postgres/service_role)는 통과.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN OLD;
    END IF;

    IF public.get_current_role() = 'super_admin' THEN
        RETURN OLD;
    END IF;

    IF OLD.status <> 'DISCARDED' THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_DISCARDED';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_inbound_documents_discarded_before_delete ON public.inbound_documents;
CREATE TRIGGER trg_inbound_documents_discarded_before_delete
    BEFORE DELETE ON public.inbound_documents
    FOR EACH ROW EXECUTE FUNCTION public.enforce_inbound_document_discarded_before_delete();

COMMENT ON FUNCTION public.enforce_inbound_document_discarded_before_delete() IS
    '공급처 명세서는 취소(DISCARDED) 처리된 것만 완전삭제 가능 — 매입 증빙 1년 보관(20260930000106). 서버·RPC 내부·super_admin은 통과.';

ALTER TABLE public.inbound_import_rows
    ADD CONSTRAINT inbound_import_rows_weight_check CHECK (weight > 0);
