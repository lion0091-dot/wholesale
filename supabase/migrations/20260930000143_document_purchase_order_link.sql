-- 전표 ↔ 발주서 연결 (2026-09-29, 사장님 원칙: 전표를 상품과 대조해 먼저 전표에 기록하고, 그 전표로 발주서를 정리한다).
--
-- 잠긴 결정(사장님 2026-09-29): 자동으로 조용히 만들거나 고치지 않는다. "발주서 추가 생성"은
-- owner/manager가 버튼을 직접 눌러야만 실행된다(대표의 의사결정 없이 발주서가 바뀌는 일은 없다).
-- 새로 만든 발주서는 이미 실물이 다 온 것을 사후에 기록하는 것이라 그 자리에서 바로 자동 마감(발주종결)된다.
--
-- 두 진입점:
--   1) 전표 대조 화면 — 전표(거래처가 정해져 있음)에 이어진 박스가 발주서에 못 붙은 만큼만 새 발주서로 등록한다.
--      전표는 이미 있으니 새로 안 만든다. (create_purchase_order_from_document_scan)
--   2) 보류함 화면(새로 만듦) — 발주서에 없는 물건(UNLISTED_HELD)이거나 초과로 받은 물건(OVER_HELD)으로
--      재고엔 들어갔지만 전표가 없는 박스. 발주서와 전표를 둘 다 만든다. (create_purchase_order_from_unlisted_scan)

-- ------------------------------------------------------------------
-- 전표에 거래처 — 전표 올릴 때 자유 입력한 이름과 별개로, 실제 거래처 목록 중 하나를 고르면 채워진다.
-- 옛 전표는 비어 있을 수 있다(대조 화면에서 나중에 고르면 됨).
-- ------------------------------------------------------------------
ALTER TABLE public.inbound_documents
    ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES public.suppliers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_inbound_documents_supplier
    ON public.inbound_documents (wholesaler_id, supplier_id)
    WHERE supplier_id IS NOT NULL;

COMMENT ON COLUMN public.inbound_documents.supplier_id IS
    '이 전표가 어느 거래처 것인지(발주서 연결용). 옛 전표는 비어 있을 수 있다 — 대조 화면에서 고르면 채워진다.';

-- ------------------------------------------------------------------
-- 스캔 하나의 "발주서 줄에 아직 안 붙은 무게" — 이미 다른 발주서 줄들에 채워진 만큼을 뺀 나머지.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scan_unassigned_weight(p_scan_id UUID)
RETURNS NUMERIC
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT s.weight - COALESCE((SELECT sum(x.weight) FROM public.purchase_order_line_scans x WHERE x.scan_id = s.id), 0)
    FROM public.inbound_scans s
    WHERE s.id = p_scan_id;
$function$;

REVOKE EXECUTE ON FUNCTION public.scan_unassigned_weight(UUID) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------
-- 공용 내부: 스캔의 남은 무게로 새 발주서 1건 + 줄 1개를 만들고 그 자리에서 바로 이어 붙인다.
-- "이미 다 왔다"는 사후 기록이라 즉시 자동 마감(refresh_purchase_order_completion)된다.
-- owner/manager만(can_manage_wholesaler) — 대표의 의사결정 없이는 실행되지 않는다.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_retroactive_purchase_order(p_scan_id UUID, p_supplier_id UUID, p_ordered_on DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid       UUID;
    v_scan      public.inbound_scans%ROWTYPE;
    v_product   public.products%ROWTYPE;
    v_supplier  RECORD;
    v_amount    NUMERIC;
    v_order_id  UUID;
    v_line_id   UUID;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();

    IF v_wid IS NULL OR NOT public.can_manage_wholesaler(v_wid) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id AND wholesaler_id = v_wid FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status <> 'NORMAL' OR v_scan.product_id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_READY';
    END IF;

    SELECT id, name INTO v_supplier FROM public.suppliers WHERE id = p_supplier_id AND wholesaler_id = v_wid;

    IF v_supplier.id IS NULL THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
    END IF;

    v_amount := public.scan_unassigned_weight(p_scan_id);

    IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'NOTHING_TO_ASSIGN';
    END IF;

    SELECT * INTO v_product FROM public.products WHERE id = v_scan.product_id AND wholesaler_id = v_wid;

    IF v_product.id IS NULL THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    INSERT INTO public.purchase_orders (wholesaler_id, supplier_id, supplier_name, ordered_on, status, note)
    VALUES (
        v_wid, v_supplier.id, v_supplier.name, COALESCE(p_ordered_on, current_date), 'OPEN',
        '실물 입고 뒤 "발주서 추가 생성"으로 만들어짐'
    )
    RETURNING id INTO v_order_id;

    INSERT INTO public.purchase_order_lines (
        purchase_order_id, wholesaler_id, line_no, category, subcategory, grade, origin, breed, quantity, unit, product_id
    ) VALUES (
        v_order_id, v_wid, 1, v_product.category, v_product.subcategory, v_product.grade, v_product.origin,
        v_product.breed, v_amount, COALESCE(v_product.unit, 'kg'), v_product.id
    )
    RETURNING id INTO v_line_id;

    INSERT INTO public.purchase_order_line_scans (scan_id, line_id, wholesaler_id, weight, linked_by)
    VALUES (p_scan_id, v_line_id, v_wid, v_amount, auth.uid());

    UPDATE public.inbound_scans SET po_state = 'ASSIGNED' WHERE id = p_scan_id;

    PERFORM public.refresh_purchase_order_completion(v_order_id);

    RETURN jsonb_build_object('order_id', v_order_id, 'line_id', v_line_id, 'amount', v_amount);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_retroactive_purchase_order(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------
-- 진입점 1: 전표 대조 화면 — 전표는 이미 있으니 발주서만 사후 등록한다.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_purchase_order_from_document_scan(p_scan_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_doc RECORD;
BEGIN
    SELECT d.id AS document_id, d.supplier_id, d.issued_on
    INTO v_doc
    FROM public.inbound_document_line_scans ls
    JOIN public.inbound_document_lines l ON l.id = ls.line_id
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE ls.scan_id = p_scan_id;

    IF v_doc.document_id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_ON_DOCUMENT';
    END IF;

    IF v_doc.supplier_id IS NULL THEN
        RAISE EXCEPTION 'DOCUMENT_SUPPLIER_REQUIRED';
    END IF;

    RETURN public.create_retroactive_purchase_order(p_scan_id, v_doc.supplier_id, v_doc.issued_on);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_purchase_order_from_document_scan(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_order_from_document_scan(UUID) TO authenticated;

-- ------------------------------------------------------------------
-- 진입점 2: 보류함 화면 — 전표가 없으니 발주서와 전표를 둘 다 만든다.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_purchase_order_from_unlisted_scan(p_scan_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid       UUID;
    v_scan      public.inbound_scans%ROWTYPE;
    v_product   public.products%ROWTYPE;
    v_result    JSONB;
    v_document  UUID;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();

    IF v_wid IS NULL OR NOT public.can_manage_wholesaler(v_wid) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id AND wholesaler_id = v_wid;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.supplier_id IS NULL THEN
        RAISE EXCEPTION 'SCAN_HAS_NO_SUPPLIER';
    END IF;

    IF v_scan.po_state NOT IN ('UNLISTED_HELD', 'OVER_HELD') THEN
        RAISE EXCEPTION 'SCAN_NOT_HOLD';
    END IF;

    IF EXISTS (SELECT 1 FROM public.inbound_document_line_scans WHERE scan_id = p_scan_id) THEN
        RAISE EXCEPTION 'SCAN_ALREADY_ON_DOCUMENT';
    END IF;

    v_result := public.create_retroactive_purchase_order(p_scan_id, v_scan.supplier_id, v_scan.created_at::date);

    SELECT * INTO v_product FROM public.products WHERE id = v_scan.product_id;

    INSERT INTO public.inbound_documents (
        wholesaler_id, supplier_id, supplier_name, issued_on, entry_method, status, note, created_by
    )
    SELECT v_wid, v_scan.supplier_id, s.name, v_scan.created_at::date, 'MANUAL', 'CLOSED',
           '"발주서 추가 생성"으로 자동 작성됨', (SELECT id FROM public.profiles WHERE id = auth.uid())
    FROM public.suppliers s WHERE s.id = v_scan.supplier_id
    RETURNING id INTO v_document;

    INSERT INTO public.inbound_document_lines (
        document_id, line_no, item_name, product_id, trace_no, labeled_weight
    ) VALUES (
        v_document, 1, v_product.name, v_scan.product_id, v_scan.trace_no, v_scan.weight
    );

    INSERT INTO public.inbound_document_line_scans (line_id, scan_id, linked_how, linked_by)
    SELECT id, p_scan_id, 'AUTO', auth.uid() FROM public.inbound_document_lines WHERE document_id = v_document;

    RETURN v_result || jsonb_build_object('document_id', v_document);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_purchase_order_from_unlisted_scan(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_order_from_unlisted_scan(UUID) TO authenticated;

-- ------------------------------------------------------------------
-- 전표에 거래처 고르기/바꾸기 — owner/manager만. 대조가 끝났거나(CLOSED) 안 끝났거나(PENDING) 상관없이 고를 수 있다.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_document_supplier(p_document_id UUID, p_supplier_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wid UUID;
BEGIN
    v_wid := public.resolve_current_wholesaler_id();

    IF v_wid IS NULL OR NOT public.can_manage_wholesaler(v_wid) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = p_supplier_id AND wholesaler_id = v_wid) THEN
        RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
    END IF;

    UPDATE public.inbound_documents SET supplier_id = p_supplier_id, updated_at = now()
    WHERE id = p_document_id AND wholesaler_id = v_wid;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'DOCUMENT_NOT_FOUND';
    END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.set_document_supplier(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_document_supplier(UUID, UUID) TO authenticated;
