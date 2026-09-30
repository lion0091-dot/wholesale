-- 공급처 명세서 파일 보관함 (2026-09-30, 사장님 요청: "어떤 방식이든 보관만 한다")
--
-- 공급처가 준 거래명세서(엑셀·PDF·사진·팝빌에서 내려받은 파일 등)를 내용은 읽지 않고
-- 원본 그대로 보관하기만 한다. 9/28에 걷어낸 명세서 구조화·대조 기능(152)과 다르다:
-- 이 표는 파일 목록일 뿐이라 재고·매입금액·발주서와 자동으로 이어지지 않는다(잠긴 결정 —
-- 재고 확정은 박스 스캔만).
--
-- 기록 보관 의무(축산물이력법 등)를 고려해 삭제 대신 숨김만 허용한다:
--   * DELETE 정책 없음 — 앱에서도 DB 직접 호출로도 행을 지울 수 없다.
--   * UPDATE는 owner/manager가 hidden_at을 처음 채우는 것만 가능(트리거가 강제).
--   * Storage 버킷의 UPDATE·DELETE 정책도 제거해 파일 덮어쓰기·삭제를 막는다.
--   * 종이 원본을 대체한다는 보장은 하지 않는다(화면 안내 문구 참고).
--
-- 버킷 'inbound-documents'와 경로 헬퍼 can_access_wholesaler_folder()는 152가 표만 지우고
-- 남겨둔 것을 재사용한다. 경로 규칙: "<wholesaler_id>/<uuid>[.확장자]" — Storage 키에
-- 한글을 못 쓰므로 원래 파일명은 file_name 컬럼에 둔다.

INSERT INTO storage.buckets (id, name, public)
VALUES ('inbound-documents', 'inbound-documents', false)
ON CONFLICT (id) DO NOTHING;

-- 파일 하나 최대 20MB. (브라우저에서 Storage로 직접 올리므로 서버리스 요청 한도와 무관하다.)
UPDATE storage.buckets SET file_size_limit = 20971520 WHERE id = 'inbound-documents';

DROP POLICY IF EXISTS "Inbound document files update by wholesaler members" ON storage.objects;
DROP POLICY IF EXISTS "Inbound document files delete by wholesaler members" ON storage.objects;

CREATE TABLE IF NOT EXISTS public.supplier_statement_files (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id  UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    supplier_id    UUID REFERENCES public.suppliers(id) ON DELETE RESTRICT,
    statement_date DATE,
    memo           TEXT CHECK (memo IS NULL OR char_length(memo) <= 500),
    file_name      TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
    mime_type      TEXT CHECK (mime_type IS NULL OR char_length(mime_type) <= 200),
    size_bytes     BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    storage_path   TEXT NOT NULL UNIQUE,
    uploaded_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    hidden_at      TIMESTAMPTZ,
    hidden_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,

    CONSTRAINT supplier_statement_files_path_in_own_folder
        CHECK (storage_path LIKE wholesaler_id::text || '/%')
);

CREATE INDEX IF NOT EXISTS idx_supplier_statement_files_recent
    ON public.supplier_statement_files (wholesaler_id, created_at DESC)
    WHERE hidden_at IS NULL;

-- 입력 규칙: 거래처는 같은 업체 것이어야 한다. 수정 규칙: 숨김 처리 외에는 아무것도 못 바꾼다.
CREATE OR REPLACE FUNCTION public.enforce_supplier_statement_file_rules()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_owner UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.supplier_id IS NOT NULL THEN
            SELECT wholesaler_id INTO v_owner FROM public.suppliers WHERE id = NEW.supplier_id;

            IF v_owner IS DISTINCT FROM NEW.wholesaler_id THEN
                RAISE EXCEPTION 'SUPPLIER_TENANT_MISMATCH';
            END IF;
        END IF;

        -- 숨김 상태로 태어날 수 없다.
        NEW.hidden_at := NULL;
        NEW.hidden_by := NULL;

        RETURN NEW;
    END IF;

    -- UPDATE: 파일 정보·소속·거래처는 고정. 예외 1) 숨김 처리(처음 한 번만),
    -- 예외 2) 프로필이 지워질 때 FK가 uploaded_by·hidden_by를 NULL로 바꾸는 것.
    IF NEW.wholesaler_id IS DISTINCT FROM OLD.wholesaler_id
       OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
       OR NEW.statement_date IS DISTINCT FROM OLD.statement_date
       OR NEW.memo IS DISTINCT FROM OLD.memo
       OR NEW.file_name IS DISTINCT FROM OLD.file_name
       OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by AND NEW.uploaded_by IS NOT NULL) THEN
        RAISE EXCEPTION 'STATEMENT_FILE_IMMUTABLE';
    END IF;

    IF NEW.hidden_at IS DISTINCT FROM OLD.hidden_at THEN
        IF OLD.hidden_at IS NOT NULL OR NEW.hidden_at IS NULL THEN
            RAISE EXCEPTION 'STATEMENT_FILE_IMMUTABLE';
        END IF;
    ELSIF NEW.hidden_by IS DISTINCT FROM OLD.hidden_by AND NEW.hidden_by IS NOT NULL THEN
        RAISE EXCEPTION 'STATEMENT_FILE_IMMUTABLE';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_supplier_statement_file_rules() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_supplier_statement_file_rules ON public.supplier_statement_files;
CREATE TRIGGER trg_supplier_statement_file_rules
    BEFORE INSERT OR UPDATE ON public.supplier_statement_files
    FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_statement_file_rules();

ALTER TABLE public.supplier_statement_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Statement files viewable by supplier staff" ON public.supplier_statement_files;
CREATE POLICY "Statement files viewable by supplier staff" ON public.supplier_statement_files
    FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

-- 올리는 건 초대 직원까지 가능. 올린 사람은 항상 본인으로 기록된다.
DROP POLICY IF EXISTS "Statement files uploaded by supplier staff" ON public.supplier_statement_files;
CREATE POLICY "Statement files uploaded by supplier staff" ON public.supplier_statement_files
    FOR INSERT WITH CHECK (
        public.can_access_wholesaler(wholesaler_id)
        AND uploaded_by = auth.uid()
    );

-- 숨김은 owner·manager만. (트리거가 숨김 외 변경을 막는다.)
DROP POLICY IF EXISTS "Statement files hidden by owner and manager" ON public.supplier_statement_files;
CREATE POLICY "Statement files hidden by owner and manager" ON public.supplier_statement_files
    FOR UPDATE USING (public.can_manage_wholesaler(wholesaler_id))
    WITH CHECK (public.can_manage_wholesaler(wholesaler_id));

-- DELETE 정책은 일부러 만들지 않는다(기록 보관).

COMMENT ON TABLE public.supplier_statement_files IS
    '공급처가 준 명세서 원본 파일 보관함. 내용을 읽지 않고 재고·매입과 연결되지 않는다. 삭제 불가, 숨김만 가능. 종이 원본 대체를 보장하지 않는다.';
