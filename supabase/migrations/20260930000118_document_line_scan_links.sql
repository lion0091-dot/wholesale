-- 29단계 B — 명세서 줄 ↔ 실물 박스 줄 단위 대조의 DB 뼈대 (2026-09-25, 사장님 결정: 애매한 배정은 사무실에서)
--
-- 지금까지는 "이 번호가 명세서에 있나"만 봤다. 이 마이그레이션은 **줄마다 몇 박스가 와야 하고 몇 박스가 왔나**를
-- 기록해, 같은 개체 3박스·로트 한 줄에 개체 여러 줄 같은 수량 문제와 "서류엔 있는데 안 온 것 / 서류에 없는데 온 것"을
-- 셀 수 있게 한다.
--
-- 바꾸지 않는 것(잠긴 결정): **재고는 여전히 스캔이 만든다.** 여기서 하는 연결은 대조·집계용이고 재고 원장과 무관하다.
-- 상품이 애매해 PENDING_MAPPING으로 남는 박스는 예전과 똑같이 사람이 지정해야 재고에 들어가며, 그 "사람 일"이
-- 현장 화면에서 사무실 대조 화면(소넷 구현 예정, docs/inbound-document-reconciliation-spec.md)으로 옮겨가는 것뿐이다.
--
-- 설계 문서(29단계 A 남은 과제)엔 "줄에 matched_scan_id 컬럼"으로 적혀 있었는데, 줄 하나에 박스 여럿(수량 3)이
-- 붙어야 해서 연결표로 바꿨다. 줄 상태는 저장하지 않고 예정 수량 대비 붙은 박스 수로 계산한다.
--
-- 자동 배정 원칙: 해당하는 줄이 **딱 하나**이거나, 여럿이어도 아직 자리가 남은 줄이 하나일 때만 붙인다. 그 외엔 붙이지
-- 않고 사무실 화면에 남긴다 — 사전조회·상품 자동 확정과 같은 "여럿이면 되묻는다" 원칙.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. 연결표
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inbound_document_line_scans (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_id    UUID NOT NULL REFERENCES public.inbound_document_lines(id) ON DELETE CASCADE,
    -- 박스 하나는 줄 하나에만 붙는다.
    scan_id    UUID NOT NULL UNIQUE REFERENCES public.inbound_scans(id) ON DELETE CASCADE,
    linked_how TEXT NOT NULL CHECK (linked_how IN ('AUTO', 'MANUAL')),
    linked_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    linked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_document_line_scans_line ON public.inbound_document_line_scans (line_id);

COMMENT ON TABLE public.inbound_document_line_scans IS
    '명세서 줄 ↔ 입고 박스 연결(대조용, 재고와 무관). 박스 하나는 줄 하나에만. 쓰기는 RPC(link/unlink/auto_link)로만.';

ALTER TABLE public.inbound_document_line_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Document line scans viewable with their document" ON public.inbound_document_line_scans;

-- 읽기는 문서 권한을 따라간다(줄과 같은 방식). 쓰기 정책은 두지 않는다 — 박스와 문서가 같은 업체인지,
-- 문서가 대조 중(PENDING)인지 같은 교차 검사가 필요해 RPC로만 쓴다.
CREATE POLICY "Document line scans viewable with their document"
ON public.inbound_document_line_scans FOR SELECT USING (
    line_id IN (SELECT id FROM public.inbound_document_lines)
);


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. 예정 수량·줄 상태
-- ─────────────────────────────────────────────────────────────────────────────────────────────

-- 줄에 와야 하는 박스 수. 수량 칸이 없으면 1로 본다(번호 하나 = 박스 하나가 기본).
CREATE OR REPLACE FUNCTION public.document_line_expected_qty(p_quantity numeric)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
    SELECT GREATEST(1, COALESCE(round(p_quantity)::int, 1));
$function$;

-- AWAITING(0) / PARTIAL(0<n<예정) / COMPLETE(=예정) / OVER(>예정). 취소(VOIDED)된 박스는 세지 않는다.
CREATE OR REPLACE FUNCTION public.document_line_match_status(p_line_id uuid)
 RETURNS TABLE (expected integer, linked integer, status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    WITH l AS (
        SELECT public.document_line_expected_qty(quantity) AS expected
        FROM public.inbound_document_lines WHERE id = p_line_id
    ),
    n AS (
        SELECT count(*)::int AS linked
        FROM public.inbound_document_line_scans ls
        JOIN public.inbound_scans s ON s.id = ls.scan_id
        WHERE ls.line_id = p_line_id AND s.status <> 'VOIDED'
    )
    SELECT l.expected, n.linked,
           CASE WHEN n.linked = 0 THEN 'AWAITING'
                WHEN n.linked < l.expected THEN 'PARTIAL'
                WHEN n.linked = l.expected THEN 'COMPLETE'
                ELSE 'OVER' END
    FROM l, n;
$function$;

REVOKE EXECUTE ON FUNCTION public.document_line_match_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.document_line_match_status(uuid) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. 붙이기 / 떼기 (사무실 화면·자동 배정이 쓴다)
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.link_scan_to_document_line(p_scan_id uuid, p_line_id uuid, p_how text DEFAULT 'MANUAL')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_doc   public.inbound_documents%ROWTYPE;
    v_scan  public.inbound_scans%ROWTYPE;
    v_state RECORD;
BEGIN
    IF p_how NOT IN ('AUTO', 'MANUAL') THEN
        RAISE EXCEPTION 'INVALID_LINK_HOW';
    END IF;

    SELECT d.* INTO v_doc
    FROM public.inbound_documents d
    JOIN public.inbound_document_lines l ON l.document_id = d.id
    WHERE l.id = p_line_id;

    IF v_doc.id IS NULL THEN
        RAISE EXCEPTION 'DOCUMENT_LINE_NOT_FOUND';
    END IF;

    IF NOT public.can_access_wholesaler(v_doc.wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    -- 마감·취소된 서류엔 붙이지 않는다. 고치려면 먼저 되살리기/다시 열기.
    IF v_doc.status <> 'PENDING' THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_PENDING';
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    IF v_scan.id IS NULL OR v_scan.wholesaler_id <> v_doc.wholesaler_id THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status = 'VOIDED' THEN
        RAISE EXCEPTION 'SCAN_VOIDED';
    END IF;

    -- 다른 줄에 붙어 있었으면 옮긴다(박스 하나 = 줄 하나).
    INSERT INTO public.inbound_document_line_scans (line_id, scan_id, linked_how, linked_by)
    VALUES (p_line_id, p_scan_id, p_how, auth.uid())
    ON CONFLICT (scan_id) DO UPDATE
        SET line_id = EXCLUDED.line_id, linked_how = EXCLUDED.linked_how,
            linked_by = EXCLUDED.linked_by, linked_at = now();

    SELECT * INTO v_state FROM public.document_line_match_status(p_line_id);

    RETURN jsonb_build_object('line_id', p_line_id, 'scan_id', p_scan_id,
                              'expected', v_state.expected, 'linked', v_state.linked, 'status', v_state.status);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.link_scan_to_document_line(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_scan_to_document_line(uuid, uuid, text) TO authenticated;


CREATE OR REPLACE FUNCTION public.unlink_scan_from_document_line(p_scan_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_doc_status    TEXT;
BEGIN
    SELECT d.wholesaler_id, d.status INTO v_wholesaler_id, v_doc_status
    FROM public.inbound_document_line_scans ls
    JOIN public.inbound_document_lines l ON l.id = ls.line_id
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE ls.scan_id = p_scan_id;

    IF v_wholesaler_id IS NULL THEN
        RETURN false;
    END IF;

    IF NOT public.can_access_wholesaler(v_wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF v_doc_status <> 'PENDING' THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_PENDING';
    END IF;

    DELETE FROM public.inbound_document_line_scans WHERE scan_id = p_scan_id;
    RETURN true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.unlink_scan_from_document_line(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_scan_from_document_line(uuid) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 4. 자동 배정 — 박스를 찍은 직후(recordScanAction)와 명세서를 나중에 올렸을 때(relink) 부른다
-- ─────────────────────────────────────────────────────────────────────────────────────────────

-- 해당하는 줄(같은 번호·두 칸·로트↔개체 다리, 대조 중 서류만)이 하나면 붙인다. 여럿이면 자리가 남은 줄이 하나일 때만.
-- 그 외엔 NULL — 사무실 화면 몫. 이미 붙어 있으면 그 줄을 그대로 돌려준다.
CREATE OR REPLACE FUNCTION public.auto_link_scan_to_document_line(p_scan_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_existing      UUID;
    v_line_id       UUID;
    v_candidates    UUID[];
    v_count         INT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id;

    IF v_scan.id IS NULL OR v_scan.status = 'VOIDED' THEN
        RETURN NULL;
    END IF;

    SELECT line_id INTO v_existing FROM public.inbound_document_line_scans WHERE scan_id = p_scan_id;

    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    -- 후보: 대조 중(PENDING) 서류의 줄만.
    SELECT array_agg(l.id) INTO v_candidates
    FROM public.document_lines_matching_trace(v_wholesaler_id, v_scan.trace_no) l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.status = 'PENDING';

    v_count := COALESCE(array_length(v_candidates, 1), 0);

    IF v_count = 0 THEN
        RETURN NULL;
    END IF;

    IF v_count = 1 THEN
        v_line_id := v_candidates[1];
    ELSE
        -- 자리가 남은 줄이 딱 하나면 그 줄. (같은 로트 5줄 중 4줄이 찼으면 남은 한 줄로.)
        SELECT count(*), min(c::text)::uuid INTO v_count, v_line_id
        FROM unnest(v_candidates) AS c
        CROSS JOIN LATERAL public.document_line_match_status(c) st
        WHERE st.linked < st.expected;

        IF v_count <> 1 THEN
            RETURN NULL;
        END IF;
    END IF;

    PERFORM public.link_scan_to_document_line(p_scan_id, v_line_id, 'AUTO');
    RETURN v_line_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_link_scan_to_document_line(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_link_scan_to_document_line(uuid) TO authenticated;


-- 박스가 취소되면 연결도 지운다(줄 상태는 VOIDED를 안 세지만 표에 남길 이유가 없다).
CREATE OR REPLACE FUNCTION public.unlink_voided_scan()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NEW.status = 'VOIDED' AND OLD.status <> 'VOIDED' THEN
        DELETE FROM public.inbound_document_line_scans WHERE scan_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.unlink_voided_scan() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_unlink_voided_scan ON public.inbound_scans;
CREATE TRIGGER trg_unlink_voided_scan
AFTER UPDATE OF status ON public.inbound_scans
FOR EACH ROW EXECUTE FUNCTION public.unlink_voided_scan();


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 5. 명세서를 나중에 올렸을 때 — 상품 거슬러 확정(117)에 이어 줄 배정도 거슬러 한다
-- ─────────────────────────────────────────────────────────────────────────────────────────────

-- 117 본문에 두 번째 루프만 덧붙였다. 반환 형태(상품이 확정된 박스 배열)는 그대로 — 서버가 length만 본다.
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

    -- 줄 배정: 아직 어느 줄에도 안 붙은 최근 박스들. 30일은 "명세서가 뒤에 올 수 있는 기간"의 여유값이다.
    FOR v_scan IN
        SELECT s.id
        FROM public.inbound_scans s
        WHERE s.wholesaler_id = v_wholesaler_id
          AND s.status <> 'VOIDED'
          AND s.created_at > now() - interval '30 days'
          AND NOT EXISTS (SELECT 1 FROM public.inbound_document_line_scans ls WHERE ls.scan_id = s.id)
        ORDER BY s.created_at
    LOOP
        PERFORM public.auto_link_scan_to_document_line(v_scan.id);
    END LOOP;

    RETURN v_linked;
END;
$function$;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 6. 중복 의심 창 — 명세서가 "이 번호 N박스"라고 했으면 N번째까지는 정상이다
-- ─────────────────────────────────────────────────────────────────────────────────────────────

-- record_inbound_scan_base 본문은 로컬 DB pg_get_functiondef(114까지 적용된 판) 그대로, 중복 판정 한 곳만 바꿨다:
-- 같은 번호·같은 중량이 창(duplicate_scan_window) 안에 있어도, 대조 중 명세서에 그 번호 줄이 있고 아직 자리가
-- 남아 있으면(붙은 박스 < 예정 수량) 묻지 않는다. 자리가 다 찼거나 명세서가 없으면 예전대로 묻는다.
CREATE OR REPLACE FUNCTION public.record_inbound_scan_base(p_trace_no text, p_weight numeric, p_scan_type text, p_product_id uuid DEFAULT NULL::uuid, p_fail_reason text DEFAULT NULL::text, p_import_row_id uuid DEFAULT NULL::uuid, p_memo text DEFAULT NULL::text, p_confirm_duplicate boolean DEFAULT false, p_fail_detail text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_trace_no      TEXT;
    v_master        public.master_livestock%ROWTYPE;
    v_product_id    UUID;
    v_status        TEXT;
    v_scan_id       UUID;
    v_reason        TEXT;
    v_dup_at        TIMESTAMPTZ;
    v_room_left     BOOLEAN;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();
    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    IF p_weight IS NULL OR p_weight <= 0 THEN
        RAISE EXCEPTION 'INVALID_WEIGHT';
    END IF;

    v_trace_no := upper(trim(COALESCE(p_trace_no, '')));
    IF v_trace_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    IF NOT p_confirm_duplicate AND p_scan_type <> 'EXCEL' THEN
        SELECT created_at INTO v_dup_at
        FROM public.inbound_scans
        WHERE wholesaler_id = v_wholesaler_id
          AND trace_no = v_trace_no
          AND weight = p_weight
          AND status IN ('NORMAL', 'EXCEPTION', 'PENDING_MAPPING')
          AND created_at > now() - public.duplicate_scan_window()
        ORDER BY created_at DESC
        LIMIT 1;

        IF v_dup_at IS NOT NULL THEN
            -- 명세서가 이 번호로 박스 여럿을 예고했고 아직 자리가 남았으면 같은 번호가 연달아 찍히는 게 정상이다(118).
            SELECT EXISTS (
                SELECT 1
                FROM public.document_lines_matching_trace(v_wholesaler_id, v_trace_no) l
                JOIN public.inbound_documents d ON d.id = l.document_id
                CROSS JOIN LATERAL public.document_line_match_status(l.id) st
                WHERE d.status = 'PENDING'
                  AND st.linked < st.expected
            ) INTO v_room_left;

            IF NOT v_room_left THEN
                RAISE EXCEPTION 'DUPLICATE_SUSPECTED:%', to_char(v_dup_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI');
            END IF;
        END IF;
    END IF;

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_trace_no;

    IF p_product_id IS NOT NULL THEN
        SELECT id INTO v_product_id
        FROM public.products
        WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;

        IF v_product_id IS NULL THEN
            RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
        END IF;

    ELSIF v_master.trace_no IS NOT NULL AND v_master.part_name IS NOT NULL THEN
        -- 소는 원산지도 정체성 키라(lib/products/identity-key.ts) 학습된 매핑이 다른 원산지의 상품으로 새지 않게 거른다.
        SELECT m.product_id INTO v_product_id
        FROM public.trace_product_map m
        JOIN public.products p ON p.id = m.product_id
        WHERE m.wholesaler_id = v_wholesaler_id
          AND m.species_group = v_master.species_group
          AND m.part_name = v_master.part_name
          AND (m.grade IS NULL OR m.grade = v_master.grade)
          AND (
                v_master.species_group IS DISTINCT FROM '소'
                OR p.origin = public.trace_origin(v_master.trace_kind, v_master.origin_country)
          )
          -- 소 외 축종은 이력번호 출처 키(농장·도축장 …)가 다른 상품으로 새지 않게 거른다(114). 키 없는 상품은 예전 그대로.
          AND (p.trace_key IS NULL OR p.trace_key IS NOT DISTINCT FROM public.trace_identity_key(v_trace_no))
        ORDER BY m.grade NULLS LAST
        LIMIT 1;
    END IF;

    IF v_master.trace_no IS NULL THEN
        v_status := 'EXCEPTION';
        v_reason := COALESCE(p_fail_reason, 'NOT_FOUND');
    ELSIF v_product_id IS NULL THEN
        v_status := 'PENDING_MAPPING';
        v_reason := 'UNMAPPED_PRODUCT';
    ELSE
        v_status := 'NORMAL';
        v_reason := NULL;
    END IF;

    INSERT INTO public.inbound_scans (
        wholesaler_id, trace_no, product_id, weight, scan_type, status,
        remaining_weight, import_row_id, memo, scanned_by
    ) VALUES (
        v_wholesaler_id, v_trace_no, v_product_id, p_weight, p_scan_type, v_status,
        CASE WHEN v_status = 'NORMAL' THEN p_weight ELSE 0 END,
        p_import_row_id, p_memo, auth.uid()
    )
    RETURNING id INTO v_scan_id;

    IF v_status = 'NORMAL' THEN
        PERFORM public.ensure_opening_balance(v_product_id);

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, created_by
        ) VALUES (
            v_wholesaler_id, v_product_id, v_scan_id, p_weight,
            'INBOUND', 'inbound_scan', v_scan_id, auth.uid()
        );

        PERFORM public.recalc_product_stock(v_product_id);
    ELSE
        INSERT INTO public.livestock_exception_log (
            wholesaler_id, inbound_scan_id, raw_input, reason, detail
        ) VALUES (
            v_wholesaler_id, v_scan_id, v_trace_no, v_reason,
            CASE WHEN v_status = 'PENDING_MAPPING'
                 THEN '이력 조회는 성공했으나 상품 매핑이 확정되지 않았습니다.'
                 ELSE p_fail_detail END
        );
    END IF;

    RETURN jsonb_build_object(
        'scan_id',        v_scan_id,
        'trace_no',       v_trace_no,
        'status',         v_status,
        'product_id',     v_product_id,
        'master_found',   v_master.trace_no IS NOT NULL,
        'species_group',  v_master.species_group,
        'part_name',      v_master.part_name,
        'grade',          v_master.grade,
        'slaughter_date', v_master.slaughter_date,
        'packing_date',   v_master.packing_date
    );
END;
$function$;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 7. 마감 / 다시 열기 — 사무실 화면이 쓴다
-- ─────────────────────────────────────────────────────────────────────────────────────────────

-- 미입고(COMPLETE가 아닌 줄)가 남아 있으면 사유 한 줄이 필수다. 사유는 note에 덧붙인다.
CREATE OR REPLACE FUNCTION public.close_inbound_document(p_document_id uuid, p_note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_doc        public.inbound_documents%ROWTYPE;
    v_incomplete INT;
BEGIN
    SELECT * INTO v_doc FROM public.inbound_documents WHERE id = p_document_id;

    IF v_doc.id IS NULL OR NOT public.can_access_wholesaler(v_doc.wholesaler_id) THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_FOUND';
    END IF;

    IF v_doc.status <> 'PENDING' THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_PENDING';
    END IF;

    SELECT count(*) INTO v_incomplete
    FROM public.inbound_document_lines l
    CROSS JOIN LATERAL public.document_line_match_status(l.id) st
    WHERE l.document_id = p_document_id
      AND st.status <> 'COMPLETE';

    IF v_incomplete > 0 AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
        RAISE EXCEPTION 'CLOSE_NOTE_REQUIRED:%', v_incomplete;
    END IF;

    UPDATE public.inbound_documents
    SET status = 'CLOSED',
        note = CASE
                   WHEN NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN note
                   ELSE COALESCE(note || E'\n', '') || '[마감 ' || to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') || '] ' || btrim(p_note)
               END,
        updated_at = now()
    WHERE id = p_document_id;

    RETURN jsonb_build_object('document_id', p_document_id, 'incomplete_lines', v_incomplete);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.close_inbound_document(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_inbound_document(uuid, text) TO authenticated;


CREATE OR REPLACE FUNCTION public.reopen_inbound_document(p_document_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_doc public.inbound_documents%ROWTYPE;
BEGIN
    SELECT * INTO v_doc FROM public.inbound_documents WHERE id = p_document_id;

    IF v_doc.id IS NULL OR NOT public.can_access_wholesaler(v_doc.wholesaler_id) THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_FOUND';
    END IF;

    IF v_doc.status <> 'CLOSED' THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_CLOSED';
    END IF;

    UPDATE public.inbound_documents SET status = 'PENDING', updated_at = now() WHERE id = p_document_id;
    RETURN true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reopen_inbound_document(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_inbound_document(uuid) TO authenticated;
