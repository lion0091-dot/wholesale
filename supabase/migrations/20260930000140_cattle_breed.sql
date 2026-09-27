-- 소 상품 정체성에 "품종"(한우/육우/젖소) 추가 (사장님 결정, 2026-09-28).
--
-- 소의 같은 상품 기준: 축종 + 품종 + 부위 + 등급 + 원산지. 그동안은 한우와 육우가 같은 상품으로 취급됐다(육우도 국내 도축이면 원산지가 국내산).
-- 품종은 이력조회가 주는 축종 원문(master_livestock.species: 한우/육우/젖소)에서 얻는다 — 번호 앞자리로는 구분되지 않는다(확인됨: 표에 세부 구조 없음).
--   - products.breed / purchase_order_lines.breed: 소에만 값이 있다. 발주서의 소 줄은 품종이 필수(라이브에 소 발주 줄 0건 확인).
--   - 기존 소 상품(라이브 1개, 보관됨)은 품종이 비어 있는 채로 둔다. 유니크 인덱스는 빈 품종끼리만 겹침으로 본다.
--   - trace_product_map(학습된 매핑)에도 품종을 넣어 한우 매핑과 육우 매핑이 서로 덮어쓰지 않게 한다.
--   - 스캔: 이력조회가 품종을 못 주면(BREED_UNKNOWN) 소 상품을 자동으로 만들거나 학습 매핑으로 붙이지 않는다 — 한우와 육우를 잘못 섞는 것보다 사무실이 고르게 둔다.
-- TS 쪽 규칙은 lib/products/identity-key.ts(소 키에 breed) — 바꾸면 양쪽을 같이 고칠 것.
-- 함수 본문은 로컬 DB의 pg_get_functiondef(139 적용 후) 기준으로 패치했다(079 방식).

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS breed TEXT,
    ADD CONSTRAINT products_breed_valid CHECK (breed IS NULL OR (category = '소' AND breed IN ('한우', '육우', '젖소')));

ALTER TABLE public.purchase_order_lines
    ADD COLUMN IF NOT EXISTS breed TEXT,
    ADD CONSTRAINT purchase_order_lines_breed_valid CHECK (
        (category = '소' AND breed IS NOT NULL AND breed IN ('한우', '육우', '젖소'))
        OR (category <> '소' AND breed IS NULL)
    );

ALTER TABLE public.trace_product_map
    ADD COLUMN IF NOT EXISTS breed TEXT;

DROP INDEX IF EXISTS public.idx_trace_product_map_unique;
CREATE UNIQUE INDEX idx_trace_product_map_unique
    ON public.trace_product_map (wholesaler_id, species_group, part_name, COALESCE(grade, ''), COALESCE(breed, ''));

DROP INDEX IF EXISTS public.idx_products_cattle_identity;
CREATE UNIQUE INDEX idx_products_cattle_identity
    ON public.products (wholesaler_id, COALESCE(breed, ''), COALESCE(subcategory, ''), COALESCE(grade, ''), COALESCE(origin, ''))
    WHERE category = '소';

-- 이력조회의 축종 원문("한우"·"육우"·"젖소" 등)을 품종 값으로 옮긴다. 셋 중 어느 것도 아니면 NULL(모른다).
CREATE OR REPLACE FUNCTION public.trace_breed(p_species text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN COALESCE(p_species, '') LIKE '%한우%' THEN '한우'
        WHEN COALESCE(p_species, '') LIKE '%육우%' THEN '육우'
        WHEN COALESCE(p_species, '') LIKE '%젖소%' THEN '젖소'
        ELSE NULL
    END;
$function$;

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
    v_breed         TEXT;
    v_uses_part     BOOLEAN;
    v_uses_grade    BOOLEAN;
    v_uses_origin   BOOLEAN;
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

    -- 상품 정체성 키(사장님 2026-09-27, lib/products/identity-key.ts와 같은 규칙):
    --   소 = 부위+등급+원산지, 돼지 = 부위+원산지, 닭·오리·계란 = 원산지(축종은 카테고리 자체). 그 밖의 축종은 예전 방식(부위+등급).
    v_is_cattle   := v_master.species_group = '소';

    -- 소는 품종(한우/육우/젖소)도 정체성 키다(사장님 2026-09-28). 이력조회가 준 축종 원문(species)에서 얻고, 못 얻으면 만들지 않는다 —
    -- 한우와 육우를 잘못 한 상품에 섞는 것보다 사무실이 상품을 직접 지정하게 두는 편이 낫다(PENDING_MAPPING으로 남는다).
    v_breed := CASE WHEN v_is_cattle THEN public.trace_breed(v_master.species) END;

    IF v_is_cattle AND v_breed IS NULL THEN
        RETURN jsonb_build_object('created', false, 'reason', 'BREED_UNKNOWN');
    END IF;
    v_uses_part   := v_master.species_group NOT IN ('닭', '오리', '계란');
    v_uses_grade  := v_master.species_group NOT IN ('돼지', '닭', '오리', '계란');
    v_uses_origin := v_master.species_group IN ('소', '돼지', '닭', '오리', '계란');

    -- 부위: 이력조회가 주면 그게 1순위(더 정형화된 값), 없으면 명세서에서
    -- 딱 하나로 좁혀지는 값을 쓴다(2026-09-24 확정 — 명세서 기반이니 부위를
    -- 모를 이유가 없다). 둘 다 없으면 예전처럼 비워서 "(부위 미지정)"으로 남긴다.
    v_part_name := NULLIF(btrim(COALESCE(v_master.part_name, '')), '');

    IF v_uses_part AND v_part_name IS NULL THEN
        v_part_name := public.lookup_document_part_name(v_wholesaler_id, v_scan.trace_no);
    END IF;

    -- 등급: 이력조회가 주면 그게 1순위. 소는 이력에 등급이 없으면 명세서 줄에서 딱 하나로 좁혀지는 값으로 채운다
    -- (2026-09-24 사장님: 기반은 명세서. 부위와 같은 방식 — 조회가 이기고 명세서는 빈칸만 메운다).
    v_grade := NULLIF(btrim(COALESCE(v_master.grade, '')), '');

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
      AND (NOT v_uses_part OR COALESCE(subcategory, '') = COALESCE(v_part_name, ''))
      AND (NOT v_uses_grade OR COALESCE(grade, '') = COALESCE(v_grade, ''))
      AND (NOT v_is_cattle OR breed = v_breed)
      AND (NOT v_uses_origin OR public.origin_matches(origin, v_origin))
    ORDER BY archived_at NULLS FIRST
    LIMIT 1;

    IF v_product_id IS NULL THEN
        IF v_is_cattle THEN
            v_name := btrim(concat_ws(' ', v_breed, v_part_name, v_grade));
        ELSIF v_master.species_group = '돼지' THEN
            v_name := COALESCE(v_part_name, '');
        ELSIF v_master.species_group IN ('닭', '오리', '계란') THEN
            v_name := v_master.species_group;
        ELSE
            v_name := btrim(
                COALESCE(NULLIF(v_master.species, ''), v_master.species_group)
                || COALESCE(' ' || v_part_name, '')
                || COALESCE(' ' || NULLIF(v_master.grade, ''), '')
            );
        END IF;

        -- 부위를 끝내 못 찾았을 때만 이름에 드러낸다.
        IF v_uses_part AND v_part_name IS NULL THEN
            v_name := btrim(v_name || ' (부위 미지정)');
        END IF;

        BEGIN
        INSERT INTO public.products (
            wholesaler_id, name, category, subcategory, origin, grade, breed,
            base_price, unit, stock_quantity, is_active, description, created_by
        ) VALUES (
            v_wholesaler_id, v_name, v_master.species_group,
            -- 정체성 키에 없는 칸은 처음 본 박스의 값이 상품 전체 값처럼 남지 않게 비워 둔다.
            CASE WHEN v_uses_part THEN v_part_name END,
            v_origin,
            CASE WHEN v_uses_grade THEN v_grade END,
            v_breed,
            0, COALESCE(NULLIF(v_scan.unit, ''), 'kg'), 0,
            -- 판매중지로 만든다 (설계 결정 4번). 가격만 넣으면 바로 팔리는 상황을 막는다.
            false,
            '입고 스캔으로 자동 등록됨 (이력번호 ' || v_scan.trace_no || ')'
            || CASE
                   WHEN v_uses_part AND v_part_name IS NULL
                       THEN ' — 이력조회·명세서 어디에도 부위가 없어 비워두었습니다. 채워주세요.'
                   ELSE ''
               END,
            auth.uid()
        )
        RETURNING id INTO v_product_id;

        v_created := true;
        EXCEPTION WHEN unique_violation THEN
            -- 같은 정체성의 상품을 동시에 만들려던 다른 요청이 먼저 만들었다 — 그 상품을 쓴다.
            SELECT id INTO v_product_id
            FROM public.products
            WHERE wholesaler_id = v_wholesaler_id
              AND category = v_master.species_group
              AND (NOT v_uses_part OR COALESCE(subcategory, '') = COALESCE(v_part_name, ''))
              AND (NOT v_uses_grade OR COALESCE(grade, '') = COALESCE(v_grade, ''))
              AND (NOT v_is_cattle OR breed = v_breed)
              AND (NOT v_uses_origin OR public.origin_matches(origin, v_origin))
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
        'part_missing', v_uses_part AND v_part_name IS NULL,
        'needs_price', (SELECT base_price = 0 FROM public.products WHERE id = v_product_id),
        'needs_activation', (SELECT NOT is_active FROM public.products WHERE id = v_product_id)
    );
END;
$function$;

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

    -- 같은 업체가 같은 번호를 동시에 두 번 보내면(스캐너 이중 발사·더블 탭) 둘 다 아래 중복 검사를 통과해 박스가 둘 생긴다.
    -- 업체+번호별로 줄을 세워 두 번째 요청이 첫 요청의 커밋을 본 뒤에 검사하게 한다(트랜잭션이 끝나면 자동 해제).
    PERFORM pg_advisory_xact_lock(hashtextextended(v_wholesaler_id::text || ':' || v_trace_no, 0));

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
                  -- 방금 기록돼 아직 줄에 안 이어진 같은 번호 박스도 자리를 차지한 것으로 센다(이어짐은 기록 다음 단계라
                  -- 그 사이에 같은 박스가 또 오면 "자리 남음"으로 잘못 통과했다). 무게로 세는 줄은 박스 수가 아니라 건너뛴다.
                  AND (
                        st.mode = 'WEIGHT'
                        OR st.linked + (
                            SELECT count(*)
                            FROM public.inbound_scans u
                            WHERE u.wholesaler_id = v_wholesaler_id
                              AND u.trace_no = v_trace_no
                              AND u.status IN ('NORMAL', 'EXCEPTION', 'PENDING_MAPPING')
                              AND u.created_at > now() - public.duplicate_scan_window()
                              AND NOT EXISTS (SELECT 1 FROM public.inbound_document_line_scans x WHERE x.scan_id = u.id)
                        ) < st.expected
                      )
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
          -- 소는 품종(한우/육우/젖소)도 정체성 키라 다른 품종의 상품으로 새지 않게 거른다. 이력조회가 품종을 못 주면 매핑하지 않는다(사무실이 고른다).
          AND (v_master.species_group <> '소' OR (p.breed IS NOT NULL AND p.breed = public.trace_breed(v_master.species)))
          -- 소·돼지·닭·오리·계란은 원산지가 정체성 키라(lib/products/identity-key.ts) 학습된 매핑이 다른 원산지의 상품으로 새지 않게 거른다.
          AND (
                v_master.species_group NOT IN ('소', '돼지', '닭', '오리', '계란')
                OR public.origin_matches(p.origin, public.trace_origin(v_master.trace_kind, v_master.origin_country))
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

CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping(p_scan_id uuid, p_product_id uuid, p_remember boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
    v_master        public.master_livestock%ROWTYPE;
    v_product_part  TEXT;
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

    IF v_scan.status NOT IN ('PENDING_MAPPING', 'EXCEPTION') THEN
        RAISE EXCEPTION 'SCAN_ALREADY_RESOLVED';
    END IF;

    PERFORM 1 FROM public.products
    WHERE id = p_product_id AND wholesaler_id = v_wholesaler_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    UPDATE public.inbound_scans
    SET product_id = p_product_id,
        status = 'NORMAL',
        remaining_weight = weight
    WHERE id = p_scan_id;

    PERFORM public.ensure_opening_balance(p_product_id);

    INSERT INTO public.stock_ledger (
        wholesaler_id, product_id, inbound_scan_id, qty_delta,
        event_type, source_type, source_id, created_by
    ) VALUES (
        v_wholesaler_id, p_product_id, p_scan_id, v_scan.weight,
        'INBOUND', 'inbound_scan', p_scan_id, auth.uid()
    );

    PERFORM public.recalc_product_stock(p_product_id);

    UPDATE public.livestock_exception_log
    SET resolved_status = 'RESOLVED',
        resolved_by = auth.uid(),
        resolved_at = now()
    WHERE inbound_scan_id = p_scan_id AND resolved_status = 'PENDING';

    SELECT * INTO v_master FROM public.master_livestock WHERE trace_no = v_scan.trace_no;
    SELECT subcategory INTO v_product_part FROM public.products WHERE id = p_product_id;

    IF p_remember THEN
        IF v_master.part_name IS NOT NULL AND v_master.species_group IS NOT NULL THEN
            INSERT INTO public.trace_product_map (
                wholesaler_id, species_group, part_name, grade, breed, product_id, created_by
            ) VALUES (
                v_wholesaler_id, v_master.species_group, v_master.part_name,
                v_master.grade, CASE WHEN v_master.species_group = '소' THEN public.trace_breed(v_master.species) END,
                p_product_id, auth.uid()
            )
            ON CONFLICT (wholesaler_id, species_group, part_name, COALESCE(grade, ''), COALESCE(breed, ''))
            DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = now();
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'scan_id', p_scan_id,
        'status', 'NORMAL',
        'product_id', p_product_id,
        'part_mismatch', public.parts_conflict(v_master.part_name, v_product_part),
        'trace_part', v_master.part_name,
        'product_part', v_product_part
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_product_options(p_wholesaler_id uuid, p_categories text[] DEFAULT NULL::text[], p_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RAISE EXCEPTION 'NOT_ALLOWED';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(
                   jsonb_build_object(
                       'id', t.id,
                       'name', t.name,
                       'category', t.category,
                       'subcategory', t.subcategory,
                       'grade', t.grade,
                       'breed', t.breed,
                       'origin', t.origin
                   )
                   ORDER BY t.category, t.name, t.id
               )
        FROM (
            SELECT p.id, p.name, p.category, p.subcategory, p.grade, p.breed, p.origin
            FROM public.products p
            WHERE p.wholesaler_id = p_wholesaler_id
              AND p.archived_at IS NULL
              AND (p_categories IS NULL OR p.category = ANY (p_categories))
              AND (p_ids IS NULL OR p.id = ANY (p_ids))
            ORDER BY p.category, p.name, p.id
            LIMIT 20000
        ) t
    ), '[]'::jsonb);
END;
$function$;
