-- 소 외 축종(돼지·닭·오리·계란)의 상품 정체성 키 = 이력번호에서 파싱한 출처 + 부위 (사장님 결정, 2026-09-24)
--
-- 12자리 이력번호는 첫 자리가 축종코드이고 그 뒤 몇 자리는 출처를 가리킨다(lib/livestock/trace-number.ts):
--   돼지 1 = 코드 1 + 농장식별번호 6 + 일련 5   → 키 '돼지:<농장6>'
--   닭   2 = 코드 1 + 도축장 3 + 일련 8         → 키 '닭:<도축장3>'
--   오리 5 = 코드 1 + 도축장 3 + 일련 8         → 키 '오리:<도축장3>'
--   계란 3 = 코드 1 + 발급월일 4 + 표시의무자 3 + 일련 4 → 키 '계란:<월일4>-<표시의무자3>'
-- 같은 공급사에서 (축종 카테고리, 이 키, 부위 — 명세서/이력에서 온 값)가 같으면 같은 상품이다. 부위가 다르면 다른 상품.
-- 소(코드 0)는 개체번호라 출처 키가 없고 별도 규칙이다(113: 축종+부위+등급+원산지).
--
-- products.trace_key는 이 자동 생성 경로에서만 채워진다. 수동 등록 상품은 NULL이라 이 규칙의 중복 검사 대상이 아니다.
-- 새 컬럼이라 기존 데이터에 중복이 있을 수 없어서 유니크 인덱스를 바로 걸 수 있다(부위가 NULL이어도 같게 취급).
-- TS 쪽 기준은 lib/livestock/trace-number.ts의 traceIdentityKey() — 바꾸면 양쪽을 같이 고칠 것.

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS trace_key TEXT;

COMMENT ON COLUMN public.products.trace_key IS
    '이력번호 파싱 출처 키(돼지 농장·닭/오리 도축장·계란 발급월일+업체). 소 외 축종의 자동 생성 상품만 채워진다.';

CREATE OR REPLACE FUNCTION public.trace_identity_key(p_trace_no text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN upper(btrim(p_trace_no)) !~ '^[0-9]{12}$' THEN NULL
        WHEN left(btrim(p_trace_no), 1) = '1' THEN '돼지:' || substr(btrim(p_trace_no), 2, 6)
        WHEN left(btrim(p_trace_no), 1) = '2' THEN '닭:' || substr(btrim(p_trace_no), 2, 3)
        WHEN left(btrim(p_trace_no), 1) = '5' THEN '오리:' || substr(btrim(p_trace_no), 2, 3)
        WHEN left(btrim(p_trace_no), 1) = '3' THEN '계란:' || substr(btrim(p_trace_no), 2, 4) || '-' || substr(btrim(p_trace_no), 6, 3)
        ELSE NULL
    END;
$function$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_trace_key_identity
    ON public.products (wholesaler_id, category, trace_key, COALESCE(subcategory, ''))
    WHERE trace_key IS NOT NULL;

-- 자동 생성 함수: 본문은 로컬 DB pg_get_functiondef(113 적용 후) 기준 패치.
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
    v_trace_key     TEXT;
    v_species_word  TEXT;
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

    -- 소 외 축종: 이력번호에서 파싱한 출처 키(돼지 농장·닭/오리 도축장 …)가 정체성의 일부다(사장님 2026-09-24).
    -- 키를 못 뽑는 번호(형식 밖)는 예전 방식(축종+부위+등급)으로 찾는다.
    v_trace_key := CASE WHEN v_is_cattle THEN NULL ELSE public.trace_identity_key(v_scan.trace_no) END;

    -- 부위가 NULL인 상품끼리도 재사용되도록 COALESCE로 비교한다.
    -- 보관된 상품도 대상에 넣는다 — 같은 조합을 다시 찍었으면 보관을 푸는 게 맞다.
    IF v_trace_key IS NOT NULL THEN
        -- 같은 출처 + 같은 부위(이력·명세서에서 온 값)면 같은 상품. 등급·원산지는 키가 아니다.
        SELECT id INTO v_product_id
        FROM public.products
        WHERE wholesaler_id = v_wholesaler_id
          AND category = v_master.species_group
          AND trace_key = v_trace_key
          AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
        ORDER BY archived_at NULLS FIRST
        LIMIT 1;
    ELSE
        SELECT id INTO v_product_id
        FROM public.products
        WHERE wholesaler_id = v_wholesaler_id
          AND category = v_master.species_group
          AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
          AND COALESCE(grade, '') = COALESCE(v_grade, '')
          AND (NOT v_is_cattle OR origin = v_origin)
        ORDER BY archived_at NULLS FIRST
        LIMIT 1;
    END IF;

    IF v_product_id IS NULL THEN
        IF v_is_cattle THEN
            v_name := btrim(concat_ws(' ', v_part_name, v_grade));
        ELSIF v_trace_key IS NOT NULL THEN
            -- 같은 부위라도 출처가 다르면 다른 상품이라 이름에 출처를 드러낸다: "삼겹살 (농장 400770)".
            -- 닭/오리는 카테고리 태그만으로 닭인지 오리인지 안 보여서 축종 글자도 붙인다.
            v_species_word := split_part(v_trace_key, ':', 1);
            v_name := btrim(
                btrim(concat_ws(' ',
                    CASE WHEN v_master.species_group = '닭/오리' THEN v_species_word END,
                    v_part_name))
                || ' ('
                || CASE v_species_word WHEN '돼지' THEN '농장' WHEN '계란' THEN '발급' ELSE '도축장' END
                || ' ' || split_part(v_trace_key, ':', 2) || ')'
            );
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

        BEGIN
        INSERT INTO public.products (
            wholesaler_id, name, category, subcategory, origin, grade,
            base_price, unit, stock_quantity, is_active, description, created_by, trace_key
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
            auth.uid(), v_trace_key
        )
        RETURNING id INTO v_product_id;

        v_created := true;
        EXCEPTION WHEN unique_violation THEN
            -- 같은 출처·부위 상품을 동시에 만들려던 다른 요청이 먼저 만들었다 — 그 상품을 쓴다.
            SELECT id INTO v_product_id
            FROM public.products
            WHERE wholesaler_id = v_wholesaler_id
              AND category = v_master.species_group
              AND trace_key = v_trace_key
              AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
            LIMIT 1;
        END;

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

-- 스캔 기록: 학습된 매핑 조회에 출처 키 조건 추가. 본문은 로컬 DB pg_get_functiondef 기준 패치.
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
