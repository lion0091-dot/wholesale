-- ====================================================================
-- 입고쪽 보안 점검 후속 (2026-09-24, 사장님 지시: 4번·6번·낮음 6개 전부 처리)
--
--  #4  공용 이력 캐시(upsert_master_livestock) 오염 차단 — service_role만 실행
--  #6  직원(staff)의 스캔 시 매입단가 입력 차단
--  #7  명세서 완전삭제는 owner/manager만 (RLS DELETE 정책)
--  #8  명세서 줄에 남의 상품 ID 저장 차단 + 조회 함수에 상품 소유 조건
--  #9  lookup_document_part_name 타업체 조회 차단
--  #10 명세서 이력번호 대소문자 불일치 — 조회 함수를 upper() 비교로
--  #11 "주문에 바로 배정"이 같은 번호의 가장 오래된 박스를 가져가던 문제 —
--      record_outbound_scan에 박스 지정(p_scan_id) 추가
--  #12 SECURITY DEFINER 헬퍼 3개 search_path 고정
--
-- 20260930000097(권한 게이트 NULL 버그)과 같은 점검에서 나온 항목들이다.
-- ====================================================================


-- --------------------------------------------------------------------
-- #12. search_path 고정 — 초기 스키마(20260909000000)의 헬퍼 3개만 빠져 있었다.
--      본문이 public.*·auth.uid()로 전부 스키마 한정돼 있어 동작 변화는 없다.
-- --------------------------------------------------------------------
ALTER FUNCTION public.get_current_role()          SET search_path = public;
ALTER FUNCTION public.get_current_wholesaler_id() SET search_path = public;
ALTER FUNCTION public.get_current_retailer_id()   SET search_path = public;


-- --------------------------------------------------------------------
-- #4. 공용 이력 캐시는 서버(service_role)만 쓴다.
--
-- master_livestock은 전 업체 공용 캐시인데, 지금까지 로그인한 공급사 계정 전원이
-- 이 함수를 RPC로 직접 불러 아무 이력번호의 등급·도축일·원산지를 덮어쓸 수
-- 있었다. 그 값은 다른 업체의 거래명세서·라벨·유통기한 경고에 그대로 쓰인다.
-- 실제 적재는 서버 액션이 정부 API 응답을 받아 하는 것이므로 브라우저 세션이
-- 부를 이유가 없다 — grant_platform_admin(20260916000000)과 같은 방식으로
-- service_role에만 EXECUTE를 남기고, 서버는 lib/livestock/master-cache.ts가
-- service_role 클라이언트로 호출한다.
--
-- 함수 안의 "공급사 계정만" 검사는 뺀다 — service_role 호출은 auth.uid()가
-- NULL이라 그 검사가 3치 논리로 우연히 통과하던 상태였다. 경계는 GRANT다.
-- 기존 로컬 DB 테스트(scripts/db-test-*.sql)는 authenticated로 이 함수를
-- 직접 부르므로, 각 스크립트 첫머리에서 테스트 세션에만 다시 GRANT한다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_master_livestock(
    p_trace_no       TEXT,
    p_trace_kind     TEXT,
    p_source         TEXT,
    p_raw_payload    JSONB,
    p_species        TEXT DEFAULT NULL,
    p_species_group  TEXT DEFAULT NULL,
    p_part_name      TEXT DEFAULT NULL,
    p_grade          TEXT DEFAULT NULL,
    p_slaughter_date DATE DEFAULT NULL,
    p_butchery_place TEXT DEFAULT NULL,
    p_farm_name      TEXT DEFAULT NULL,
    p_origin_country TEXT DEFAULT NULL,
    p_importer_name  TEXT DEFAULT NULL,
    p_packing_date   DATE DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- 호출 권한은 GRANT(service_role 전용)가 결정한다 — 위 주석 참고.
    INSERT INTO public.master_livestock AS m (
        trace_no, trace_kind, source, raw_payload, species, species_group,
        part_name, grade, slaughter_date, butchery_place, farm_name,
        origin_country, importer_name, packing_date, fetched_at
    ) VALUES (
        upper(trim(p_trace_no)), p_trace_kind, p_source, COALESCE(p_raw_payload, '{}'::jsonb),
        p_species, p_species_group, p_part_name, p_grade, p_slaughter_date,
        p_butchery_place, p_farm_name, p_origin_country, p_importer_name,
        p_packing_date, now()
    )
    ON CONFLICT (trace_no) DO UPDATE SET
        trace_kind     = EXCLUDED.trace_kind,
        source         = EXCLUDED.source,
        raw_payload    = EXCLUDED.raw_payload,
        species        = COALESCE(EXCLUDED.species, m.species),
        species_group  = COALESCE(EXCLUDED.species_group, m.species_group),
        part_name      = COALESCE(EXCLUDED.part_name, m.part_name),
        grade          = COALESCE(EXCLUDED.grade, m.grade),
        slaughter_date = COALESCE(EXCLUDED.slaughter_date, m.slaughter_date),
        butchery_place = COALESCE(EXCLUDED.butchery_place, m.butchery_place),
        farm_name      = COALESCE(EXCLUDED.farm_name, m.farm_name),
        origin_country = COALESCE(EXCLUDED.origin_country, m.origin_country),
        importer_name  = COALESCE(EXCLUDED.importer_name, m.importer_name),
        packing_date   = COALESCE(EXCLUDED.packing_date, m.packing_date),
        fetched_at     = now();
END;
$$;

-- 20260930000053은 REVOKE FROM PUBLIC을 안 해서 anon까지 실행 권한이 남아 있었다.
REVOKE EXECUTE ON FUNCTION public.upsert_master_livestock(
    TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, DATE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_master_livestock(
    TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, DATE
) TO service_role;


-- --------------------------------------------------------------------
-- #6. 직원(staff)은 스캔 시 매입단가를 못 넣는다.
--
-- 매입단가는 원가라 화면(/dashboard/purchases)과 update_inbound_purchase가
-- owner/manager로 잠겨 있는데, 입고 스캔의 p_purchase_unit_price는 역할을 안
-- 봐서 staff가 스캔 경로로 단가를 정할 수 있었다. 단가를 안 넘기면 상품 기본
-- 매입단가(관리자가 정한 값)가 그대로 따라 들어가므로 입고 자체는 막지 않는다.
-- 매입처(p_purchase_supplier)는 원가가 아니라 그대로 둔다.
-- 본문은 20260930000073과 동일, 첫머리 검사만 추가.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_inbound_scan(
    p_trace_no            TEXT,
    p_weight              NUMERIC,
    p_scan_type           TEXT,
    p_product_id          UUID    DEFAULT NULL,
    p_fail_reason         TEXT    DEFAULT NULL,
    p_import_row_id       UUID    DEFAULT NULL,
    p_memo                TEXT    DEFAULT NULL,
    p_confirm_duplicate   BOOLEAN DEFAULT false,
    p_best_before         DATE    DEFAULT NULL,
    p_labeled_weight      NUMERIC DEFAULT NULL,
    p_purchase_unit_price NUMERIC DEFAULT NULL,
    p_purchase_supplier   TEXT    DEFAULT NULL,
    p_fail_detail         TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result    JSONB;
    v_scan_id   UUID;
    v_scan      public.inbound_scans%ROWTYPE;
    v_default   public.product_purchase_prices%ROWTYPE;
    v_price     NUMERIC(12, 2);
    v_supplier  TEXT;
BEGIN
    IF p_purchase_unit_price IS NOT NULL
       AND NOT public.can_manage_wholesaler(public.resolve_current_wholesaler_id()) THEN
        RAISE EXCEPTION 'FORBIDDEN_PURCHASE_PRICE';
    END IF;

    v_result := public.record_inbound_scan_base(
        p_trace_no, p_weight, p_scan_type, p_product_id,
        p_fail_reason, p_import_row_id, p_memo, p_confirm_duplicate,
        p_fail_detail
    );

    v_scan_id := NULLIF(v_result ->> 'scan_id', '')::UUID;

    IF v_scan_id IS NULL THEN
        RETURN v_result;
    END IF;

    IF p_best_before IS NOT NULL THEN
        UPDATE public.inbound_scans SET best_before = p_best_before WHERE id = v_scan_id;

        v_result := v_result || jsonb_build_object(
            'best_before', p_best_before,
            'days_left',   p_best_before - CURRENT_DATE,
            'expired',     p_best_before < CURRENT_DATE
        );
    END IF;

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = v_scan_id;

    IF v_scan.product_id IS NOT NULL THEN
        SELECT * INTO v_default
        FROM public.product_purchase_prices WHERE product_id = v_scan.product_id;
    END IF;

    v_price    := COALESCE(p_purchase_unit_price, v_default.unit_price);
    v_supplier := COALESCE(
        NULLIF(btrim(COALESCE(p_purchase_supplier, '')), ''),
        v_default.supplier_name
    );

    UPDATE public.inbound_scans
    SET labeled_weight      = COALESCE(p_labeled_weight, labeled_weight),
        purchase_unit_price = v_price,
        purchase_supplier   = v_supplier
    WHERE id = v_scan_id
    RETURNING * INTO v_scan;

    RETURN v_result || jsonb_build_object(
        'labeled_weight',      v_scan.labeled_weight,
        'weight_variance',     v_scan.weight_variance,
        'variance_ratio',      CASE
                                   WHEN v_scan.labeled_weight IS NULL OR v_scan.labeled_weight = 0 THEN NULL
                                   ELSE ROUND(v_scan.weight_variance / v_scan.labeled_weight, 4)
                               END,
        'variance_exceeded',   CASE
                                   WHEN v_scan.labeled_weight IS NULL OR v_scan.labeled_weight = 0 THEN false
                                   ELSE abs(v_scan.weight_variance / v_scan.labeled_weight)
                                        > public.inbound_weight_tolerance()
                               END,
        'purchase_unit_price', v_scan.purchase_unit_price,
        'purchase_amount',     v_scan.purchase_amount,
        'purchase_supplier',   v_scan.purchase_supplier
    );
END;
$$;


-- --------------------------------------------------------------------
-- #7. 명세서 완전삭제(원본 포함)는 owner/manager만.
--     매입 명세서는 축산물이력법상 1년 보관 대상이라 staff에게까지 열지 않는다.
--     취소 처리(UPDATE→DISCARDED)는 그대로 staff도 할 수 있다.
--     서버 액션(saveInboundDocumentAction)이 줄 저장 실패 때 껍데기 문서를
--     지우던 정리 경로는 이제 DISCARDED로 바꾸는 방식으로 함께 고쳤다.
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Inbound documents deletable by owner or org staff" ON public.inbound_documents;
DROP POLICY IF EXISTS "Inbound documents deletable by owner or org manager" ON public.inbound_documents;
CREATE POLICY "Inbound documents deletable by owner or org manager"
ON public.inbound_documents FOR DELETE USING (
    public.can_manage_wholesaler(wholesaler_id)
);


-- --------------------------------------------------------------------
-- #8. 명세서 줄의 product_id는 그 문서 업체의 상품이어야 한다.
--     지금까지는 아무 상품 UUID나 저장됐다(FK만 있음). 스캔 시
--     record_inbound_scan이 PRODUCT_NOT_FOUND로 막긴 했지만 스캔 자체가 실패로
--     끝났다. 넣는 단계(RLS)와 읽는 단계(조회 함수) 양쪽에서 막는다.
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "Document lines writable with their document" ON public.inbound_document_lines;
CREATE POLICY "Document lines writable with their document"
ON public.inbound_document_lines FOR INSERT WITH CHECK (
    document_id IN (SELECT id FROM public.inbound_documents)
    AND (
        product_id IS NULL
        OR EXISTS (
            SELECT 1
            FROM public.products p
            JOIN public.inbound_documents d ON d.id = inbound_document_lines.document_id
            WHERE p.id = inbound_document_lines.product_id
              AND p.wholesaler_id = d.wholesaler_id
        )
    )
);

DROP POLICY IF EXISTS "Document lines updatable with their document" ON public.inbound_document_lines;
CREATE POLICY "Document lines updatable with their document"
ON public.inbound_document_lines FOR UPDATE USING (
    document_id IN (SELECT id FROM public.inbound_documents)
) WITH CHECK (
    document_id IN (SELECT id FROM public.inbound_documents)
    AND (
        product_id IS NULL
        OR EXISTS (
            SELECT 1
            FROM public.products p
            JOIN public.inbound_documents d ON d.id = inbound_document_lines.document_id
            WHERE p.id = inbound_document_lines.product_id
              AND p.wholesaler_id = d.wholesaler_id
        )
    )
);

-- 조회 쪽: 상품 소유 조건 추가(#8) + 대소문자 무시 비교(#10).
-- 서버 액션은 이제 저장 시 trace_no를 대문자로 정규화하지만, 이미 저장된 줄과
-- 손으로 고친 줄이 섞여 있을 수 있어 비교는 upper()로 한다(테이블이 작아 인덱스 손해 무시).
CREATE OR REPLACE FUNCTION public.lookup_product_by_document_trace(p_trace_no TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_product_id    UUID;
    v_distinct      INT;
    v_trace_no      TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RETURN NULL;
    END IF;

    v_trace_no := upper(btrim(p_trace_no));

    SELECT count(DISTINCT l.product_id) INTO v_distinct
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    JOIN public.products p          ON p.id = l.product_id
    WHERE d.wholesaler_id = v_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND upper(l.trace_no) = v_trace_no
      AND l.product_id IS NOT NULL
      AND p.wholesaler_id = v_wholesaler_id
      AND p.archived_at IS NULL;

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    SELECT DISTINCT l.product_id INTO v_product_id
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    JOIN public.products p          ON p.id = l.product_id
    WHERE d.wholesaler_id = v_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND upper(l.trace_no) = v_trace_no
      AND l.product_id IS NOT NULL
      AND p.wholesaler_id = v_wholesaler_id
      AND p.archived_at IS NULL;

    RETURN v_product_id;
END;
$$;


-- --------------------------------------------------------------------
-- #9. lookup_document_part_name — 업체 ID를 인자로 받는데 누구나 호출할 수 있어
--     남의 명세서 부위값이 새어 나갔다. 접근 가능한 업체가 아니면 NULL.
--     (autocreate_product_for_scan이 같은 사용자 세션에서 자기 업체 ID로 부르므로
--     내부 호출은 그대로 통과한다.) 대소문자 무시 비교(#10)도 함께.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lookup_document_part_name(p_wholesaler_id UUID, p_trace_no TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_distinct INT;
    v_part     TEXT;
    v_trace_no TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN NULL;
    END IF;

    v_trace_no := upper(btrim(p_trace_no));

    SELECT count(DISTINCT l.part_name) INTO v_distinct
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND upper(l.trace_no) = v_trace_no
      AND l.part_name IS NOT NULL
      AND btrim(l.part_name) <> '';

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    SELECT DISTINCT l.part_name INTO v_part
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND upper(l.trace_no) = v_trace_no
      AND l.part_name IS NOT NULL
      AND btrim(l.part_name) <> '';

    RETURN v_part;
END;
$$;


-- --------------------------------------------------------------------
-- #11. 출고 스캔에 "이 박스"를 지정할 수 있게 한다.
--
-- resolve_inbound_mapping_to_order("주문에 바로 배정")는 방금 상품을 확정한
-- 박스를 주문에 붙이려는 기능인데, record_outbound_scan이 이력번호로 가장
-- 오래된 박스를 고르기 때문에 같은 번호의 다른(오래된) 박스가 나가고, 그
-- 박스가 기한이 지났으면 상품 지정까지 통째로 롤백됐다.
-- p_scan_id(선택)를 추가한다. 넘기면 그 박스만 본다. 인자가 늘어 기존 3인자
-- 함수는 지운다(같이 두면 3인자 호출이 모호해진다). 본문은 20260930000084와 동일.
-- --------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_outbound_scan(UUID, TEXT, NUMERIC);

CREATE FUNCTION public.record_outbound_scan(
    p_order_id UUID,
    p_trace_no TEXT,
    p_weight   NUMERIC DEFAULT NULL,
    p_scan_id  UUID    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_order         public.orders%ROWTYPE;
    v_trace_no      TEXT;
    v_box           public.inbound_scans%ROWTYPE;
    v_ordered       NUMERIC(10, 3);
    v_assigned      NUMERIC(10, 3);
    v_needed        NUMERIC(10, 3);
    v_take          NUMERIC(10, 3);
    v_row           RECORD;
    v_trace_part    TEXT;
    v_product_part  TEXT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;

    IF v_order.id IS NULL OR v_order.wholesaler_id <> v_wholesaler_id THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- 확보 대기(awaiting_stock)도 받는다. 물건이 아직 없는 주문이라 오히려
    -- 입고하면서 바로 붙일 대상이다. 이중 차감은 apply_order_shipment가
    -- 상품별 순 출고량으로 판정하도록 고쳐서 막았다(31단계).
    IF v_order.status NOT IN ('awaiting_stock', 'confirmed', 'shipping') THEN
        RAISE EXCEPTION 'ORDER_NOT_SHIPPABLE:%', v_order.status;
    END IF;

    -- 마감(청구 금액 확정)된 주문은 더 이상 스캔을 받지 않는다. 마감 후 스캔을
    -- 허용하면 재고만 더 빠져나가고 금액·명세서에는 반영될 방법이 없다.
    IF v_order.shipment_finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'ALREADY_FINALIZED';
    END IF;

    v_trace_no := upper(btrim(COALESCE(p_trace_no, '')));

    IF p_scan_id IS NOT NULL THEN
        -- 박스가 지정됐으면 그 박스만 본다(#11). 이력번호는 박스 것을 쓴다.
        SELECT * INTO v_box
        FROM public.inbound_scans
        WHERE id = p_scan_id
          AND wholesaler_id = v_wholesaler_id
          AND status = 'NORMAL'
          AND remaining_weight > 0
        FOR UPDATE;

        IF v_box.id IS NULL THEN
            RAISE EXCEPTION 'BOX_NOT_AVAILABLE';
        END IF;

        v_trace_no := v_box.trace_no;
    ELSE
        IF v_trace_no = '' THEN
            RAISE EXCEPTION 'EMPTY_TRACE_NO';
        END IF;

        SELECT * INTO v_box
        FROM public.inbound_scans
        WHERE wholesaler_id = v_wholesaler_id
          AND trace_no = v_trace_no
          AND status = 'NORMAL'
          AND remaining_weight > 0
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE;

        IF v_box.id IS NULL THEN
            RAISE EXCEPTION 'BOX_NOT_AVAILABLE';
        END IF;
    END IF;

    -- 기한이 지난 박스는 내보내지 않는다 (설계 결정 2번). 부위 불일치와 달리
    -- 판단의 여지가 없어 확인 버튼으로 넘기게 두지 않는다.
    IF v_box.best_before IS NOT NULL AND v_box.best_before < CURRENT_DATE THEN
        RAISE EXCEPTION 'BOX_EXPIRED:%', to_char(v_box.best_before, 'YYYY-MM-DD');
    END IF;

    -- 이 상품이 이 주문에서 처음 스캔되는 거면, 그 상품의 자동 배정만 되돌린다.
    -- 주문 전체를 되돌리면(구버전) 아직 안 찍은 다른 상품의 ORDER_OUT 행까지
    -- 지워져서, 부분 스캔 상태의 명세서·마감 계산이 그 상품을 출고 0으로 본다.
    IF NOT EXISTS (
        SELECT 1 FROM public.stock_ledger
        WHERE source_type = 'order' AND source_id = p_order_id
          AND event_type = 'OUTBOUND_UNASSIGN'
          AND product_id = v_box.product_id
    ) THEN
        FOR v_row IN
            SELECT product_id, inbound_scan_id, qty_delta
            FROM public.stock_ledger
            WHERE source_type = 'order' AND source_id = p_order_id AND event_type = 'ORDER_OUT'
              AND product_id = v_box.product_id
        LOOP
            IF v_row.inbound_scan_id IS NOT NULL THEN
                UPDATE public.inbound_scans
                SET remaining_weight = remaining_weight + (-v_row.qty_delta)
                WHERE id = v_row.inbound_scan_id AND status = 'NORMAL';
            END IF;

            INSERT INTO public.stock_ledger (
                wholesaler_id, product_id, inbound_scan_id, qty_delta,
                event_type, source_type, source_id, reason, created_by
            ) VALUES (
                v_wholesaler_id, v_row.product_id, v_row.inbound_scan_id, -v_row.qty_delta,
                'OUTBOUND_UNASSIGN', 'order', p_order_id, '출고 스캔으로 배정 정정', auth.uid()
            );
        END LOOP;

        -- 자동 배정을 되돌리면서 지정 박스의 잔량이 바뀌었을 수 있다 — 다시 읽는다.
        SELECT * INTO v_box FROM public.inbound_scans WHERE id = v_box.id;
    END IF;

    SELECT COALESCE(SUM(quantity), 0) INTO v_ordered
    FROM public.order_items
    WHERE order_id = p_order_id AND product_id = v_box.product_id;

    IF v_ordered <= 0 THEN
        RAISE EXCEPTION 'PRODUCT_NOT_IN_ORDER';
    END IF;

    SELECT COALESCE(SUM(-qty_delta), 0) INTO v_assigned
    FROM public.stock_ledger
    WHERE source_type = 'order' AND source_id = p_order_id
      AND event_type = 'OUTBOUND_ASSIGN'
      AND product_id = v_box.product_id;

    v_needed := v_ordered - v_assigned;

    IF v_needed <= 0 THEN
        RAISE EXCEPTION 'PRODUCT_ALREADY_FULFILLED';
    END IF;

    v_take := LEAST(v_box.remaining_weight, v_needed, COALESCE(p_weight, v_box.remaining_weight));

    IF v_take <= 0 THEN
        RAISE EXCEPTION 'INVALID_WEIGHT';
    END IF;

    UPDATE public.inbound_scans
    SET remaining_weight = remaining_weight - v_take
    WHERE id = v_box.id;

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, created_by
    ) VALUES (
        v_wholesaler_id, v_box.product_id, v_box.id, -v_take,
        'OUTBOUND_ASSIGN', 'order', p_order_id, auth.uid()
    );

    PERFORM public.recalc_product_stock(v_box.product_id);

    -- 부위 대조 (막지 않고 알리기만 한다, 설계 결정 1번)
    SELECT part_name INTO v_trace_part FROM public.master_livestock WHERE trace_no = v_trace_no;
    SELECT subcategory INTO v_product_part FROM public.products WHERE id = v_box.product_id;

    RETURN jsonb_build_object(
        'trace_no', v_trace_no,
        'product_id', v_box.product_id,
        'product_name', (SELECT name FROM public.products WHERE id = v_box.product_id),
        'taken', v_take,
        'ordered', v_ordered,
        'assigned', v_assigned + v_take,
        'remaining_needed', v_needed - v_take,
        'best_before',  v_box.best_before,
        'days_left',    v_box.best_before - CURRENT_DATE,
        'part_mismatch', public.parts_conflict(v_trace_part, v_product_part),
        'trace_part', v_trace_part,
        'product_part', v_product_part
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_outbound_scan(UUID, TEXT, NUMERIC, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_outbound_scan(UUID, TEXT, NUMERIC, UUID) TO authenticated;

-- "주문에 바로 배정"은 방금 확정한 그 박스를 지정해서 보낸다.
CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping_to_order(
    p_scan_id    UUID,
    p_product_id UUID,
    p_order_id   UUID,
    p_remember   BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_resolve  JSONB;
    v_outbound JSONB;
    v_scan     public.inbound_scans%ROWTYPE;
BEGIN
    v_resolve := public.resolve_inbound_mapping(p_scan_id, p_product_id, p_remember);

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    -- p_weight를 생략(NULL)하면 record_outbound_scan이 "박스 잔량과 주문에 필요한
    -- 양 중 작은 쪽"을 알아서 가져간다 — 방금 들어온 박스가 주문보다 커도 문제없다.
    v_outbound := public.record_outbound_scan(p_order_id, v_scan.trace_no, NULL, p_scan_id);

    RETURN jsonb_build_object('resolve', v_resolve, 'outbound', v_outbound);
END;
$$;
