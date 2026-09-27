-- 상품 정체성 키 확장 + 닭·오리·계란 카테고리 분리 (사장님 결정, 2026-09-27)
--
--   소   = 축종 + 부위 + 등급 + 원산지 (그대로)
--   돼지 = 축종 + 부위 + 원산지
--   닭·오리·계란 = 축종 + 원산지 — 닭과 오리는 이력번호 첫 자리로 갈리므로 "닭/오리" 카테고리를 처음부터 닭·오리로 나누고 계란도 카테고리로 둔다.
--   이 밖의 칸(등급 등)은 자유 기입.
-- 이 규칙은 lib/products/identity-key.ts와 같다 — 바꾸면 양쪽을 같이 고칠 것.
--
-- 114의 "이력번호 출처 키"(돼지 농장·닭/오리 도축장, products.trace_key)는 상품을 가르는 기준에서 빠진다 — 발주 전엔 알 수 없는 값이라 미리 등록이 불가능했다.
-- 그래서 trace_key 컬럼·유니크 인덱스·trace_identity_key()를 지운다(라이브에서 trace_key가 채워진 상품 0건 확인 후).
-- 함수 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로 패치했다(마이그레이션 파일이 아니라 — 079 방식).

-- 안전장치: 옛 "닭/오리" 카테고리를 쓰는 데이터가 남아 있으면 닭인지 오리인지 자동으로 알 수 없으니 중단한다.
DO $$
DECLARE
    r RECORD;
    n BIGINT;
BEGIN
    FOR r IN
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public'
          AND c.column_name IN ('category', 'species_group')
          AND c.data_type = 'text'
    LOOP
        EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = %L', r.table_name, r.column_name, '닭/오리') INTO n;

        IF n > 0 THEN
            RAISE EXCEPTION 'CATEGORY_IN_USE: %.% 에 "닭/오리" 행이 % 건 있어 카테고리를 나눌 수 없습니다.', r.table_name, r.column_name, n;
        END IF;
    END LOOP;
END $$;

-- 카테고리: 닭/오리 → 닭, 오리·계란 추가. 순서 소 1, 돼지 2, 닭 3, 오리 4, 계란 5, 양 6, 가공육 7.
UPDATE public.product_categories SET sort_order = 7 WHERE name = '가공육';
UPDATE public.product_categories SET sort_order = 6 WHERE name = '양';
UPDATE public.product_categories SET name = '닭', sort_order = 3 WHERE name = '닭/오리';

INSERT INTO public.product_categories (name, sort_order)
SELECT v.name, v.sort_order
FROM (VALUES ('오리', 4), ('계란', 5)) AS v(name, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.product_categories c WHERE c.name = v.name);

-- 기존 "닭/오리" 부위 중 오리 전용 하나만 오리로 옮긴다.
UPDATE public.product_subcategories
SET category_id = (SELECT id FROM public.product_categories WHERE name = '오리'), sort_order = 1
WHERE name = '오리훈제'
  AND category_id = (SELECT id FROM public.product_categories WHERE name = '닭');

-- 출처 키 제거.
DROP INDEX IF EXISTS public.idx_products_trace_key_identity;
ALTER TABLE public.products DROP COLUMN IF EXISTS trace_key;
DROP FUNCTION IF EXISTS public.trace_identity_key(text);

-- 새 정체성 키를 DB가 강제한다(소는 121이 이미 강제).
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_pork_identity
    ON public.products (wholesaler_id, COALESCE(subcategory, ''), COALESCE(origin, ''))
    WHERE category = '돼지';

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_poultry_egg_identity
    ON public.products (wholesaler_id, category, COALESCE(origin, ''))
    WHERE category IN ('닭', '오리', '계란');

-- 이력 정보로 원산지를 정하는 규칙(113의 것을 바꾼다) — 국내 이력제(mtrace)에 번호가 있으면 국내산, 수입 이력이면 API가 준 국가명을
-- 원산지 목록(lib/products/origin-options.ts)의 값으로 옮기고, 목록에 없는 나라(또 국가명이 없을 때)는 '기타 수입산'으로 둔다(사장님 2026-09-28).
-- TS 쪽은 origin-options.ts의 normalizeImportedOrigin() — 바꾸면 양쪽을 같이 고칠 것(원산지 표기는 법적 문제).
CREATE OR REPLACE FUNCTION public.trace_origin(p_trace_kind text, p_origin_country text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN p_trace_kind = 'imported' THEN
            CASE
                WHEN COALESCE(p_origin_country, '') LIKE '%미국%' THEN '미국산'
                WHEN COALESCE(p_origin_country, '') LIKE '%호주%' THEN '호주산'
                WHEN COALESCE(p_origin_country, '') LIKE '%뉴질랜드%' THEN '뉴질랜드산'
                WHEN COALESCE(p_origin_country, '') LIKE '%캐나다%' THEN '캐나다산'
                WHEN COALESCE(p_origin_country, '') LIKE '%브라질%' THEN '브라질산'
                WHEN COALESCE(p_origin_country, '') LIKE '%스페인%' THEN '스페인산'
                ELSE '기타 수입산'
            END
        ELSE '국내산'
    END;
$function$;

-- 원산지 비교 — 한쪽이 다른 쪽을 포함하면 같은 원산지로 본다(사장님 결정 "원산지는 like로", 2026-09-28).
-- 이력조회는 수입 원산지를 국가명 그대로("미국") 주고 상품·발주서는 "미국산"으로 적어 정확히 같지 않기 때문이다.
-- 둘 중 하나가 비어 있으면 포함 비교가 무의미하니(빈 문자열은 모든 것에 포함된다) 둘 다 비었을 때만 같다.
CREATE OR REPLACE FUNCTION public.origin_matches(p_a text, p_b text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN NULLIF(btrim(p_a), '') IS NULL OR NULLIF(btrim(p_b), '') IS NULL
            THEN NULLIF(btrim(p_a), '') IS NULL AND NULLIF(btrim(p_b), '') IS NULL
        ELSE position(btrim(p_a) IN btrim(p_b)) > 0 OR position(btrim(p_b) IN btrim(p_a)) > 0
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
      AND (NOT v_uses_origin OR public.origin_matches(origin, v_origin))
    ORDER BY archived_at NULLS FIRST
    LIMIT 1;

    IF v_product_id IS NULL THEN
        IF v_is_cattle THEN
            v_name := btrim(concat_ws(' ', v_part_name, v_grade));
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
            wholesaler_id, name, category, subcategory, origin, grade,
            base_price, unit, stock_quantity, is_active, description, created_by
        ) VALUES (
            v_wholesaler_id, v_name, v_master.species_group,
            -- 정체성 키에 없는 칸은 처음 본 박스의 값이 상품 전체 값처럼 남지 않게 비워 둔다.
            CASE WHEN v_uses_part THEN v_part_name END,
            v_origin,
            CASE WHEN v_uses_grade THEN v_grade END,
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
