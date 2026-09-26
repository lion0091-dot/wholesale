-- 전표(inbound_documents)와 전표 줄(inbound_document_lines)을 로그인한 직원이 API로 직접 고치지 못하게 잠근다. (사장님 2026-09-26)
--
-- 그동안 박스(inbound_scans)와 재고 원장(stock_ledger)은 쓰기 정책이 없어 함수로만 바뀌었지만, 전표와 줄은 그 업체 직원(사장·매니저·직원)이
-- 마감된 뒤에도 수량·무게·번호·상품·상태를 직접 바꿀 수 있었다. 전표 줄은 "다 왔는지" 판정과 자동 마감, 상품 자동 결정에 쓰이므로
-- 손으로 바꾸면 그 결과가 달라진다. 화면에는 저장 뒤 수정 기능이 없었으니 화면이 하던 일은 그대로 되고, 못 하던 일이 DB에서도 막힌다.
--
-- 방식:
--   · 줄: 앱이 직접 쓰는 컬럼(사전조회 상태·오류)만 UPDATE를 남기고 나머지는 컬럼 권한을 회수한다. DELETE는 정책·권한을 없앤다
--         (전표 완전 삭제 때의 줄 삭제는 ON DELETE CASCADE라 이 권한과 무관하다). INSERT는 전표를 만든 직후 10분 안에만 허용한다.
--   · 전표: UPDATE 컬럼을 status·note·storage_path로 좁히고, 상태 전이는 취소(→DISCARDED)·되살리기(DISCARDED→DRAFT/PENDING)만 허용한다.
--         마감·다시 열기·스캔 종료 표시는 원래 함수(SECURITY DEFINER)로만 되므로 영향이 없다.
--   · 함수 안에서 실행되는 쓰기(current_user가 authenticated가 아님)와 서비스 키·DB 관리자는 그대로 통과한다.
--   · super_admin 계정이 API로 함수를 부르는 경로는 그대로 둔다(운영 지원용, 사장님 결정).

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. 전표 줄
-- ─────────────────────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Document lines deletable with their document" ON public.inbound_document_lines;

REVOKE DELETE ON public.inbound_document_lines FROM authenticated, anon;
REVOKE UPDATE ON public.inbound_document_lines FROM authenticated, anon;
GRANT UPDATE (prelookup_status, prelookup_error) ON public.inbound_document_lines TO authenticated;

-- 줄은 전표를 저장하는 그 요청 안에서만 들어간다 — 전표를 만든 지 10분이 지났거나 대조 중이 아니면 새 줄을 못 넣는다.
DROP POLICY IF EXISTS "Document lines writable with their document" ON public.inbound_document_lines;

CREATE POLICY "Document lines writable with their document"
ON public.inbound_document_lines FOR INSERT
WITH CHECK (
    document_id IN (SELECT id FROM public.inbound_documents)
    AND EXISTS (
        SELECT 1 FROM public.inbound_documents d
        WHERE d.id = inbound_document_lines.document_id
          AND d.status IN ('DRAFT', 'PENDING')
          AND d.created_at > now() - interval '10 minutes'
    )
    AND (
        product_id IS NULL
        OR EXISTS (
            SELECT 1
            FROM public.products p
            JOIN public.inbound_documents d ON d.id = inbound_document_lines.document_id
            WHERE p.id = inbound_document_lines.product_id AND p.wholesaler_id = d.wholesaler_id
        )
    )
);


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. 전표
-- ─────────────────────────────────────────────────────────────────────────────────────────────

REVOKE UPDATE ON public.inbound_documents FROM authenticated, anon;
GRANT UPDATE (status, note, storage_path) ON public.inbound_documents TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_inbound_document_direct_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- 함수(SECURITY DEFINER)·서비스 키·DB 관리자의 쓰기는 그대로 통과한다. API로 들어온 로그인 사용자만 제한한다.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('DRAFT', 'PENDING') OR NEW.scan_finished_at IS NOT NULL OR NEW.scan_finished_by IS NOT NULL THEN
            RAISE EXCEPTION 'DOCUMENT_WRITE_DENIED';
        END IF;

        RETURN NEW;
    END IF;

    -- 상태는 취소(대조 중·초안·마감 → 취소됨)와 되살리기(취소됨 → 초안·대조 중)만 직접 바꿀 수 있다.
    -- 마감·다시 열기는 close_inbound_document / reopen_inbound_document 함수로만 된다.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (NEW.status = 'DISCARDED' AND OLD.status IN ('DRAFT', 'PENDING', 'CLOSED'))
            OR (OLD.status = 'DISCARDED' AND NEW.status IN ('DRAFT', 'PENDING'))
        ) THEN
            RAISE EXCEPTION 'DOCUMENT_STATUS_CHANGE_DENIED';
        END IF;
    END IF;

    -- 메모는 "품목 저장 실패로 자동 취소됨"처럼 취소하면서 남길 때만. 마감 사유는 함수가 붙인다.
    IF NEW.note IS DISTINCT FROM OLD.note AND NOT (NEW.status = 'DISCARDED' AND OLD.status <> 'DISCARDED') THEN
        RAISE EXCEPTION 'DOCUMENT_WRITE_DENIED';
    END IF;

    -- 원본 파일 경로는 처음 올릴 때 한 번만.
    IF NEW.storage_path IS DISTINCT FROM OLD.storage_path
       AND NOT (OLD.storage_path IS NULL AND OLD.status IN ('DRAFT', 'PENDING')) THEN
        RAISE EXCEPTION 'DOCUMENT_WRITE_DENIED';
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.enforce_inbound_document_direct_writes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_inbound_documents_direct_writes ON public.inbound_documents;

CREATE TRIGGER trg_inbound_documents_direct_writes
BEFORE INSERT OR UPDATE ON public.inbound_documents
FOR EACH ROW EXECUTE FUNCTION public.enforce_inbound_document_direct_writes();


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. 전표를 취소 처리하면 그 전표 줄에 이어졌던 박스를 푼다
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 전표 줄을 고칠 수 없게 되면 "잘못 올린 전표를 취소 처리하고 다시 올리기"가 정정의 유일한 길이다. 그런데 취소해도 박스가 옛 전표 줄에
-- 그대로 묶여 있으면 새 전표에 이어지지 않고 "연결 안 된 박스" 목록에도 안 나온다(이미 이어진 것으로 보인다).
-- 그래서 취소되는 순간 연결을 푼다. 박스와 재고는 그대로다 — 연결은 대조용일 뿐이다. 되살리면 앱이 다시 이어 준다.
CREATE OR REPLACE FUNCTION public.unlink_scans_of_discarded_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NEW.status = 'DISCARDED' AND OLD.status <> 'DISCARDED' THEN
        DELETE FROM public.inbound_document_line_scans
        WHERE line_id IN (SELECT id FROM public.inbound_document_lines WHERE document_id = NEW.id);
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.unlink_scans_of_discarded_document() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_inbound_documents_unlink_on_discard ON public.inbound_documents;

CREATE TRIGGER trg_inbound_documents_unlink_on_discard
AFTER UPDATE OF status ON public.inbound_documents
FOR EACH ROW EXECUTE FUNCTION public.unlink_scans_of_discarded_document();
