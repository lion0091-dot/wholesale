-- 공급처 원본 명세서 업로드 → "들어올 예정"(미확정 입고) (29단계 A)
--
-- 상위 공급처(도축장·대형유통사)가 납품과 함께 주는 거래명세서/납품명세서를
-- 원본 그대로 올려두고, 거기 적힌 품목 줄들을 "아직 안 들어온 예정 물량"으로
-- 걸어두는 단계다.
--
-- 기존 엑셀 대량 입고(inbound_import_jobs/rows, 13단계)와 목적이 다르다:
--   - 대량 입고: 우리가 정한 형식(이력번호+중량)을 받아 "즉시 입고를 실행"하는 큐
--   - 이 테이블: 공급처가 준 남의 형식 문서를 "증빙으로 보관 + 대조 대상으로 대기"
-- 그래서 rows.trace_no가 NOT NULL인 기존 구조로는 담을 수 없다(이력번호가
-- 아예 안 적혀 오는 공급처가 있다 — 사장님 확인).
--
-- 잠긴 설계 결정 (2026-09-23, 사장님 확정):
--   * 서류만으로는 절대 재고가 잡히지 않는다. 재고는 박스를 찍어야만 생긴다.
--     서류로 재고를 만들면 (1) 실물 없는 고기가 미니샵에 떠서 식당이 주문할 수
--     있고 (2) 이력번호가 빈 채 재고가 생겨 나중에 거래명세서에 이력을 못 찍는다.
--     따라서 이 마이그레이션은 stock_ledger / products.stock_quantity를 일절
--     건드리지 않는다. 트리거도 없다.
--   * 이력번호는 공급처마다 적혀 오기도 하고 안 오기도 한다. 그래서 trace_no는
--     nullable이고, 대조(B단계)는 번호가 있으면 번호로, 없으면 품목+중량 추정으로
--     간다.
--
-- 재고에 영향이 없으므로 쓰기를 RPC로 강제하지 않고 RLS 직접 쓰기를 허용한다 —
-- inbound_import_jobs와 같은 예외 사유다(livestock 설계 결정 6번).


-- --------------------------------------------------------------------
-- 0. Storage 경로 권한 헬퍼
-- --------------------------------------------------------------------
-- 명세서는 팀이 함께 보는 문서라, 업로더 개인(auth.uid()) 폴더에 두는
-- business-licenses 방식을 쓸 수 없다(초대 직원이 사장 업로드분을 못 본다).
-- 경로를 "<wholesaler_id>/..."로 두고 업체 단위로 판정한다.
--
-- 폴더명이 UUID가 아닐 수 있으므로(잘못 만든 경로, 공격 시도) 캐스팅 실패를
-- 예외로 삼키고 거부한다 — 정책 안에서 그냥 ::uuid를 쓰면 에러가 나서 조회
-- 자체가 터진다.
CREATE OR REPLACE FUNCTION public.can_access_wholesaler_folder(p_folder TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN
    BEGIN
        v_id := p_folder::UUID;
    EXCEPTION WHEN others THEN
        RETURN FALSE;
    END;

    RETURN v_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(v_id);
END;
$$;

COMMENT ON FUNCTION public.can_access_wholesaler_folder(TEXT) IS
    'Storage 경로 첫 세그먼트(업체 UUID)에 현재 사용자가 접근 가능한지. owner와 초대 직원 모두 인정.';


-- --------------------------------------------------------------------
-- 1. INBOUND_DOCUMENTS — 올린 명세서 한 장 = 한 행
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inbound_documents (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id  UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,

    -- 상위 공급처 이름. 자유 입력이고, 같은 이름으로 다음에 올릴 때
    -- supplier_document_formats에서 읽는 방법을 재사용하는 학습 키가 된다.
    supplier_name  TEXT,
    -- 명세서 번호/발행일 (서류에 있으면).
    document_no    TEXT,
    issued_on      DATE,

    -- 원본 파일. 수기 입력이면 파일이 없을 수 있어 nullable.
    file_name      TEXT,
    mime_type      TEXT,
    storage_path   TEXT,

    -- AUTO:   파일에서 줄을 자동으로 읽어냄
    -- MANUAL: 글자를 못 뽑는 파일(사진 PDF 등)이라 사람이 보고 입력함
    entry_method   TEXT NOT NULL DEFAULT 'AUTO'
                   CHECK (entry_method IN ('AUTO', 'MANUAL')),

    -- DRAFT:     올렸고 사람이 표를 확인하는 중 (아직 예정 목록에 안 뜸)
    -- PENDING:   확인 끝, "들어올 예정"으로 대기
    -- CLOSED:    처리 완료로 마감
    -- DISCARDED: 잘못 올렸거나 취소된 서류
    status         TEXT NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT', 'PENDING', 'CLOSED', 'DISCARDED')),

    -- 서류에 찍힌 합계 금액. 줄 합계와 대조해 잘못 읽은 걸 잡는 검산용.
    total_amount   NUMERIC(14, 2),
    note           TEXT,

    created_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_documents_recent
    ON public.inbound_documents (wholesaler_id, created_at DESC);

-- "지금 뭐가 들어올 예정인가" 목록 전용.
CREATE INDEX IF NOT EXISTS idx_inbound_documents_pending
    ON public.inbound_documents (wholesaler_id, issued_on DESC)
    WHERE status = 'PENDING';


-- --------------------------------------------------------------------
-- 2. INBOUND_DOCUMENT_LINES — 명세서의 품목 한 줄 = 한 행
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inbound_document_lines (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID NOT NULL REFERENCES public.inbound_documents(id) ON DELETE CASCADE,
    line_no      INTEGER NOT NULL,

    -- 읽어낸 원문 한 줄 전체. 파싱이 틀렸을 때 사람이 원본과 대조하려면 필요하다
    -- (master_livestock.raw_payload와 같은 방어).
    raw_text     TEXT,

    -- 서류에 적힌 품목명 그대로. "돈 삼겹 냉장" 같은 공급처 표기라
    -- 우리 상품명과 다를 수 있다.
    item_name    TEXT,
    -- 사람이 우리 상품으로 지목했으면 채워진다. 안 해도 예정 목록은 뜬다.
    product_id   UUID REFERENCES public.products(id) ON DELETE SET NULL,

    -- 적혀 있으면 채운다. 안 적어 보내는 공급처가 있어 nullable (잠긴 결정).
    trace_no     TEXT,

    -- 등급(1++, 1+, 1, 2, 3). 필수가 아니다 — 이력번호가 있으면 공공 이력조회가
    -- 채워주고 그 값이 우선이다. 다만 이력번호도 등급도 없으면 품질을 확인할
    -- 방법이 아예 없어서 화면이 짚어준다 (사장님 확정 2026-09-23).
    grade        TEXT,

    -- 박스 수 등 수량. 중량과 별개로 적혀 오는 경우가 있다.
    quantity     NUMERIC(12, 3),
    -- 서류에 적힌 중량은 플랫폼의 "표기중량"이다 — 공급처가 주장하는 값이고,
    -- 창고 저울로 잰 실중량(inbound_scans.weight)과 대조할 대상이다.
    -- 24단계가 이미 표기중량 vs 실중량 ±2% 오차를 보는 구조를 갖고 있어
    -- 새 개념을 만들지 않고 같은 이름을 쓴다(서류 중량을 실중량으로 오해하면
    -- 매입금액이 통째로 틀어진다).
    labeled_weight NUMERIC(10, 3) CHECK (labeled_weight IS NULL OR labeled_weight > 0),
    unit_price   NUMERIC(12, 2) CHECK (unit_price IS NULL OR unit_price >= 0),
    amount       NUMERIC(14, 2),

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (document_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_inbound_document_lines_doc
    ON public.inbound_document_lines (document_id, line_no);

-- 대조(B단계)와 "이 번호가 어느 서류로 들어왔나" 추적용.
CREATE INDEX IF NOT EXISTS idx_inbound_document_lines_trace
    ON public.inbound_document_lines (trace_no)
    WHERE trace_no IS NOT NULL;


-- --------------------------------------------------------------------
-- 3. SUPPLIER_DOCUMENT_FORMATS — 공급처별 서류 읽는 법 학습
-- --------------------------------------------------------------------
-- 형식이 제각각인 문서를 미리 다 알아내는 건 불가능하다. 대신 이 저장소가 이미
-- 쓰는 방식을 그대로 쓴다 — trace_product_map이 "부위→상품"을 한 번 물어보고
-- 학습하듯, 여기서는 "몇 번째 칸이 품목/중량/단가인지"를 한 번 받아 저장하고
-- 같은 공급처 서류는 다음부터 자동으로 읽는다.
--
-- column_map 예: {"item_name": 1, "weight": 3, "unit_price": 4, "trace_no": 0,
--                 "header_rows": 2}
-- 형식이 언제든 바뀔 수 있어 컬럼을 고정하지 않고 jsonb로 둔다.
CREATE TABLE IF NOT EXISTS public.supplier_document_formats (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id  UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    -- 대소문자·공백 차이로 학습이 갈라지지 않도록 정규화한 값을 넣는다.
    supplier_key   TEXT NOT NULL,
    supplier_name  TEXT NOT NULL,
    column_map     JSONB NOT NULL DEFAULT '{}'::jsonb,
    sample_header  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (wholesaler_id, supplier_key)
);


-- --------------------------------------------------------------------
-- 4. RLS
-- --------------------------------------------------------------------
ALTER TABLE public.inbound_documents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_document_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_document_formats ENABLE ROW LEVEL SECURITY;

-- 중간에 실패해도 다시 돌릴 수 있게 정책은 항상 재생성한다
-- (CREATE POLICY에는 IF NOT EXISTS가 없다).
DROP POLICY IF EXISTS "Inbound documents viewable by owner, org staff, or admin" ON public.inbound_documents;
DROP POLICY IF EXISTS "Inbound documents writable by owner or org staff"        ON public.inbound_documents;
DROP POLICY IF EXISTS "Inbound documents updatable by owner or org staff"       ON public.inbound_documents;
DROP POLICY IF EXISTS "Inbound documents deletable by owner or org staff"       ON public.inbound_documents;
DROP POLICY IF EXISTS "Document lines viewable with their document"             ON public.inbound_document_lines;
DROP POLICY IF EXISTS "Document lines writable with their document"             ON public.inbound_document_lines;
DROP POLICY IF EXISTS "Document lines updatable with their document"            ON public.inbound_document_lines;
DROP POLICY IF EXISTS "Document lines deletable with their document"            ON public.inbound_document_lines;
DROP POLICY IF EXISTS "Document formats viewable by owner, org staff, or admin" ON public.supplier_document_formats;
DROP POLICY IF EXISTS "Document formats writable by owner or org staff"         ON public.supplier_document_formats;
DROP POLICY IF EXISTS "Document formats updatable by owner or org staff"        ON public.supplier_document_formats;

-- 입고는 현장 작업이라 staff까지 읽고 쓸 수 있어야 한다(기존 입고 스캔과 동일).
-- 단가·금액이 담기지만 이미 /dashboard/purchases가 같은 수준으로 열려 있다.
CREATE POLICY "Inbound documents viewable by owner, org staff, or admin"
ON public.inbound_documents FOR SELECT USING (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
    OR public.get_current_role() = 'super_admin'
);

CREATE POLICY "Inbound documents writable by owner or org staff"
ON public.inbound_documents FOR INSERT WITH CHECK (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
);

CREATE POLICY "Inbound documents updatable by owner or org staff"
ON public.inbound_documents FOR UPDATE USING (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
) WITH CHECK (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
);

-- 잘못 올린 서류를 치울 수 있어야 한다. 재고와 무관하므로 삭제가 안전하다
-- (기록이 재고의 근거가 되는 stock_ledger와 다르다).
CREATE POLICY "Inbound documents deletable by owner or org staff"
ON public.inbound_documents FOR DELETE USING (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
);

-- 줄은 문서 권한을 그대로 따라간다. 서브쿼리가 문서 정책을 타므로
-- 남의 업체 문서에는 줄을 넣을 수도 볼 수도 없다.
CREATE POLICY "Document lines viewable with their document"
ON public.inbound_document_lines FOR SELECT USING (
    document_id IN (SELECT id FROM public.inbound_documents)
);

CREATE POLICY "Document lines writable with their document"
ON public.inbound_document_lines FOR INSERT WITH CHECK (
    document_id IN (SELECT id FROM public.inbound_documents)
);

CREATE POLICY "Document lines updatable with their document"
ON public.inbound_document_lines FOR UPDATE USING (
    document_id IN (SELECT id FROM public.inbound_documents)
) WITH CHECK (
    document_id IN (SELECT id FROM public.inbound_documents)
);

CREATE POLICY "Document lines deletable with their document"
ON public.inbound_document_lines FOR DELETE USING (
    document_id IN (SELECT id FROM public.inbound_documents)
);

CREATE POLICY "Document formats viewable by owner, org staff, or admin"
ON public.supplier_document_formats FOR SELECT USING (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
    OR public.get_current_role() = 'super_admin'
);

CREATE POLICY "Document formats writable by owner or org staff"
ON public.supplier_document_formats FOR INSERT WITH CHECK (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
);

CREATE POLICY "Document formats updatable by owner or org staff"
ON public.supplier_document_formats FOR UPDATE USING (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
) WITH CHECK (
    wholesaler_id = public.get_current_wholesaler_id()
    OR public.is_org_staff_of_wholesaler(wholesaler_id)
);


-- --------------------------------------------------------------------
-- 5. GRANT / 트리거
-- --------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_documents        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_document_lines   TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.supplier_document_formats TO authenticated;
GRANT ALL ON public.inbound_documents        TO service_role;
GRANT ALL ON public.inbound_document_lines   TO service_role;
GRANT ALL ON public.supplier_document_formats TO service_role;

DROP TRIGGER IF EXISTS trg_inbound_documents_updated_at ON public.inbound_documents;
CREATE TRIGGER trg_inbound_documents_updated_at
    BEFORE UPDATE ON public.inbound_documents
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_inbound_document_lines_updated_at ON public.inbound_document_lines;
CREATE TRIGGER trg_inbound_document_lines_updated_at
    BEFORE UPDATE ON public.inbound_document_lines
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_supplier_document_formats_updated_at ON public.supplier_document_formats;
CREATE TRIGGER trg_supplier_document_formats_updated_at
    BEFORE UPDATE ON public.supplier_document_formats
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- --------------------------------------------------------------------
-- 6. Storage 버킷 — 원본 명세서 보관
-- --------------------------------------------------------------------
-- 명세서에는 거래처명·단가·금액이 그대로 담긴다. 반드시 private.
INSERT INTO storage.buckets (id, name, public)
VALUES ('inbound-documents', 'inbound-documents', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Inbound document files insert by wholesaler members" ON storage.objects;
DROP POLICY IF EXISTS "Inbound document files select by wholesaler members" ON storage.objects;
DROP POLICY IF EXISTS "Inbound document files update by wholesaler members" ON storage.objects;
DROP POLICY IF EXISTS "Inbound document files delete by wholesaler members" ON storage.objects;

CREATE POLICY "Inbound document files insert by wholesaler members"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'inbound-documents'
    AND public.can_access_wholesaler_folder((storage.foldername(name))[1])
);

CREATE POLICY "Inbound document files select by wholesaler members"
ON storage.objects FOR SELECT TO authenticated
USING (
    bucket_id = 'inbound-documents'
    AND (
        public.can_access_wholesaler_folder((storage.foldername(name))[1])
        OR public.get_current_role() = 'super_admin'
    )
);

CREATE POLICY "Inbound document files update by wholesaler members"
ON storage.objects FOR UPDATE TO authenticated
USING (
    bucket_id = 'inbound-documents'
    AND public.can_access_wholesaler_folder((storage.foldername(name))[1])
) WITH CHECK (
    bucket_id = 'inbound-documents'
    AND public.can_access_wholesaler_folder((storage.foldername(name))[1])
);

CREATE POLICY "Inbound document files delete by wholesaler members"
ON storage.objects FOR DELETE TO authenticated
USING (
    bucket_id = 'inbound-documents'
    AND public.can_access_wholesaler_folder((storage.foldername(name))[1])
);


COMMENT ON TABLE public.inbound_documents IS
    '공급처가 준 원본 명세서 1장. 재고를 만들지 않는다 — 재고는 박스 스캔만이 만든다(잠긴 결정).';
COMMENT ON TABLE public.inbound_document_lines IS
    '명세서의 품목 1줄. trace_no는 안 적어 보내는 공급처가 있어 nullable.';
COMMENT ON TABLE public.supplier_document_formats IS
    '공급처별 서류 읽는 법 학습. 한 번 짚어주면 같은 공급처 서류는 다음부터 자동으로 읽는다.';
