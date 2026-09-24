-- 소 상품 정체성 키 = 축종 + 부위 + 등급 + 원산지 (사장님 결정, 2026-09-24; lib/products/identity-key.ts와 같은 규칙)
--
-- 이력 입고 자동 생성(autocreate_product_for_scan)이 소에 대해:
--   1) 기존 상품을 찾을 때 원산지까지 본다(예전엔 축종+부위+등급만 봐서 수입산과 국내산이 한 상품에 묶일 수 있었다).
--   2) 상품명을 '부위 등급'으로 만든다(예전 '한우 등심 1++'). 축종은 화면이 [소] 태그로 자동으로 붙인다.
--      부위가 없으면 끝에 '(부위 미지정)'.
--   3) 이력에 등급이 없으면 명세서 줄에서 딱 하나로 좁혀지는 등급으로 채운다(lookup_document_grade — 부위와 같은 방식,
--      조회가 주는 값이 항상 우선). 사장님: "기반은 명세서".
--   4) 스캔 기록 함수(record_inbound_scan_base)의 학습된 매핑 조회도 소는 원산지가 같은 상품만 후보로 삼는다
--      (매핑 테이블 trace_product_map에는 원산지가 없어, 수입 소 이력이 국내산 상품에 조용히 붙던 구멍).
-- 소 외 축종(돼지·닭·오리…)은 규칙이 정해지지 않아 예전 동작 그대로다.
-- 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로 패치했다(마이그레이션 파일이 아니라 — 079 방식).

-- 이력 정보로 원산지를 정하는 규칙 — 국내 이력제(mtrace)에 번호가 있으면 국내산, 수입 이력이면 API가 준 국가명(없으면 '수입산').
-- 예전엔 autocreate_product_for_scan 안에만 있었는데, 학습된 매핑 조회(record_inbound_scan_base)도 같은 값을 써야 해서 한 곳으로 모았다.
-- TS 쪽 기준은 lib/livestock/inbound-requirements.ts의 resolveTraceOrigin() — 바꾸면 양쪽을 같이 고칠 것(원산지 표기는 법적 문제).
CREATE OR REPLACE FUNCTION public.trace_origin(p_trace_kind text, p_origin_country text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN p_trace_kind = 'imported' THEN COALESCE(NULLIF(p_origin_country, ''), '수입산')
        ELSE '국내산'
    END;
$function$;

CREATE OR REPLACE FUNCTION public.lookup_document_grade(p_wholesaler_id uuid, p_trace_no text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_distinct INT;
    v_grade    TEXT;
    v_trace_no TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN NULL;
    END IF;

    v_trace_no := upper(btrim(p_trace_no));

    SELECT count(DISTINCT btrim(l.grade)) INTO v_distinct
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND upper(l.trace_no) = v_trace_no
      AND l.grade IS NOT NULL
      AND btrim(l.grade) <> '';

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    SELECT DISTINCT btrim(l.grade) INTO v_grade
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND upper(l.trace_no) = v_trace_no
      AND l.grade IS NOT NULL
      AND btrim(l.grade) <> '';

    RETURN v_grade;
END;
$function$;

-- 자동 생성 함수 안에서만 부른다(SECURITY DEFINER 내부 호출) — 브라우저 세션이 직접 부를 이유가 없다.
REVOKE EXECUTE ON FUNCTION public.lookup_document_grade(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.autocreate_product_for_scan(p_scan_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_master        public.master_livestock%ROWTYPE;
    v_product_id    UUID;
    v_part_name     TEXT;
    v_grade         TEXT;
    v_is_cattle     BOOLEAN;
    v_name          TEXT;
    v_origin        TEXT;
    v_created       BOOLEAN := false;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_scan
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id
    FOR UPDATE;

    IF v_scan.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_scan.status <> 'PENDING_MAPPING' THEN
        RAISE EXCEPTION 'SCAN_ALREADY_RESOLVED';
    END IF;

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_scan.trace_no;

    -- 축종조차 모르면 만들 수 없다. 이름도 분류도 세울 수 없기 때문이다.
    IF v_master.species_group IS NULL THEN
        RETURN jsonb_build_object('created', false, 'reason', 'INSUFFICIENT_TRACE_INFO');
    END IF;

    -- 부위: 이력조회가 주면 그게 1순위(더 정형화된 값), 없으면 명세서에서
    -- 딱 하나로 좁혀지는 값을 쓴다(2026-09-24 확정 — 명세서 기반이니 부위를
    -- 모를 이유가 없다). 둘 다 없으면 예전처럼 비워서 "(부위 미지정)"으로 남긴다.
    v_part_name := NULLIF(btrim(COALESCE(v_master.part_name, '')), '');

    IF v_part_name IS NULL THEN
        v_part_name := public.lookup_document_part_name(v_wholesaler_id, v_scan.trace_no);
    END IF;

    -- 등급: 이력조회가 주면 그게 1순위. 소는 이력에 등급이 없으면 명세서 줄에서 딱 하나로 좁혀지는 값으로 채운다
    -- (2026-09-24 사장님: 기반은 명세서. 부위와 같은 방식 — 조회가 이기고 명세서는 빈칸만 메운다).
    v_grade := NULLIF(btrim(COALESCE(v_master.grade, '')), '');
    v_is_cattle := v_master.species_group = '소';

    IF v_is_cattle AND v_grade IS NULL THEN
        v_grade := public.lookup_document_grade(v_wholesaler_id, v_scan.trace_no);
    END IF;

    v_origin := public.trace_origin(v_master.trace_kind, v_master.origin_country);

    -- 부위가 NULL인 상품끼리도 재사용되도록 COALESCE로 비교한다.
    -- 보관된 상품도 대상에 넣는다 — 같은 조합을 다시 찍었으면 보관을 푸는 게 맞다.
    SELECT id INTO v_product_id
    FROM public.products
    WHERE wholesaler_id = v_wholesaler_id
      AND category = v_master.species_group
      AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
      AND COALESCE(grade, '') = COALESCE(v_grade, '')
      AND (NOT v_is_cattle OR origin = v_origin)
    ORDER BY archived_at NULLS FIRST
    LIMIT 1;

    IF v_product_id IS NULL THEN
        IF v_is_cattle THEN
            v_name := btrim(concat_ws(' ', v_part_name, v_grade));
        ELSE
            v_name := btrim(
                COALESCE(NULLIF(v_master.species, ''), v_master.species_group)
                || COALESCE(' ' || v_part_name, '')
                || COALESCE(' ' || NULLIF(v_master.grade, ''), '')
            );
        END IF;

        -- 부위를 끝내 못 찾았을 때만 이름에 드러낸다.
        IF v_part_name IS NULL THEN
            v_name := btrim(v_name || ' (부위 미지정)');
        END IF;

        INSERT INTO public.products (
            wholesaler_id, name, category, subcategory, origin, grade,
            base_price, unit, stock_quantity, is_active, description, created_by
        ) VALUES (
            v_wholesaler_id, v_name, v_master.species_group, v_part_name,
            v_origin, v_grade,
            0, COALESCE(NULLIF(v_scan.unit, ''), 'kg'), 0,
            -- 판매중지로 만든다 (설계 결정 4번). 가격만 넣으면 바로 팔리는 상황을 막는다.
            false,
            '입고 스캔으로 자동 등록됨 (이력번호 ' || v_scan.trace_no || ')'
            || CASE
                   WHEN v_part_name IS NULL
                       THEN ' — 이력조회·명세서 어디에도 부위가 없어 비워두었습니다. 채워주세요.'
                   ELSE ''
               END,
            auth.uid()
        )
        RETURNING id INTO v_product_id;

        v_created := true;

    ELSE
        UPDATE public.products
        SET archived_at = NULL, updated_at = now()
        WHERE id = v_product_id AND archived_at IS NOT NULL;
    END IF;

    PERFORM public.resolve_inbound_mapping(p_scan_id, v_product_id, true);

    -- 바코드에 상품코드가 있었다면 그것도 함께 학습한다. 부위가 안 와도
    -- 이 코드로는 다음부터 정확히 같은 상품에 붙는다.
    PERFORM public.learn_gtin_product(p_scan_id, v_product_id);

    RETURN jsonb_build_object(
        'created', v_created,
        'product_id', v_product_id,
        'product_name', (SELECT name FROM public.products WHERE id = v_product_id),
        'part_missing', v_part_name IS NULL,
        'needs_price', (SELECT base_price = 0 FROM public.products WHERE id = v_product_id),
        'needs_activation', (SELECT NOT is_active FROM public.products WHERE id = v_product_id)
    );
END;
$function$;

-- 스캔 기록(record_inbound_scan_base): 학습된 매핑 조회에 소 원산지 조건 추가. 본문은 로컬 DB pg_get_functiondef 기준 패치.
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
            RAISE EXCEPTION 'DUPLICATE_SUSPECTED:%', to_char(v_dup_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI');
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
