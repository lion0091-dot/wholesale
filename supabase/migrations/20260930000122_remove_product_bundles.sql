-- 자체 세트 상품(BOM) 개념 제거 (사장님 결정, 2026-09-26: "세트 상품은 없는 개념")
--
-- 23단계에서 넣은 세트(자체 상품코드·세트번호·구성 이력번호 역추적)를 전부 걷어낸다.
--   1) 세트 전용 표 4개·함수 9개·트리거를 삭제한다.
--   2) 세트를 풀어 보여 주던 거래명세서·라벨·재고 요약 함수는 세트 없이 쓰도록 다시 만든다.
--   3) 세트 전용 값(scan_type 'BUNDLE', 원장 BUNDLE_* 이벤트, source_type 'bundle')을 CHECK에서 뺀다.
--   4) 소 정체성 유니크 인덱스(121)에서 "단위가 세트면 제외" 우회를 없앤다 — 세트가 없으니 우회도 필요 없다.
--
-- 라이브에는 세트 관련 행이 전부 0건임을 확인하고 만든 마이그레이션이다. 그래도 데이터가 있으면 아무것도 지우지 않고
-- 멈추도록 첫머리에서 검사한다(잃을 데이터가 있는 상태로 실행되지 않게).
-- 함수 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로 고쳤다(079 방식).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.product_bundles)
       OR EXISTS (SELECT 1 FROM public.bundle_assemblies)
       OR EXISTS (SELECT 1 FROM public.bundle_assembly_sources)
       OR EXISTS (SELECT 1 FROM public.product_bundle_items) THEN
        RAISE EXCEPTION 'BUNDLE_DATA_EXISTS: 세트 데이터가 있어 삭제하지 않습니다';
    END IF;

    IF EXISTS (SELECT 1 FROM public.products WHERE unit = '세트') THEN
        RAISE EXCEPTION 'SET_UNIT_PRODUCTS_EXIST: 단위가 세트인 상품이 있어 삭제하지 않습니다';
    END IF;

    IF EXISTS (SELECT 1 FROM public.stock_ledger WHERE event_type LIKE 'BUNDLE%' OR source_type = 'bundle')
       OR EXISTS (SELECT 1 FROM public.inbound_scans WHERE scan_type = 'BUNDLE') THEN
        RAISE EXCEPTION 'BUNDLE_LEDGER_EXISTS: 세트 원장·스캔 기록이 있어 삭제하지 않습니다';
    END IF;
END $$;

-- 1) 세트 전용 트리거·함수 ------------------------------------------------------
DROP TRIGGER IF EXISTS trg_products_keep_bundle_unit ON public.products;

DO $$
DECLARE
    v_fn regprocedure;
BEGIN
    FOR v_fn IN
        SELECT p.oid::regprocedure
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN (
              'keep_bundle_product_unit',
              'save_product_bundle',
              'delete_product_bundle',
              'list_product_bundles',
              'bundle_buildable_sets',
              'assemble_product_bundle',
              'disassemble_bundle_assembly',
              'list_bundle_assemblies',
              'get_bundle_labels',
              'trace_bundle_usage'
          )
    LOOP
        EXECUTE 'DROP FUNCTION ' || v_fn;
    END LOOP;
END $$;

-- 2) 세트를 풀어 보여 주던 함수: 세트 없이 다시 만든다 ------------------------------
-- 거래명세서에 실리는 이력번호 목록 — 세트 구성 전개 가지를 뺐다.
CREATE OR REPLACE FUNCTION public.get_order_trace_numbers(p_order_id uuid)
 RETURNS TABLE(product_id uuid, product_name text, trace_no text, quantity numeric, grade text, slaughter_date date, butchery_place text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    WITH shipped AS (
        SELECT l.product_id, l.inbound_scan_id, -l.qty_delta AS qty
        FROM public.stock_ledger l
        JOIN public.orders o ON o.id = l.source_id
        WHERE l.source_type = 'order'
          AND l.source_id = p_order_id
          AND l.inbound_scan_id IS NOT NULL
          -- 출고 스캔이 있었으면 그것만, 없으면 자동 배정분을 쓴다.
          -- 상품마다 스캔 여부가 다를 수 있어 상품 단위로 판정한다.
          AND l.event_type = CASE
                WHEN EXISTS (
                    SELECT 1 FROM public.stock_ledger x
                    WHERE x.source_type = 'order' AND x.source_id = p_order_id
                      AND x.event_type = 'OUTBOUND_ASSIGN'
                      AND x.product_id = l.product_id
                ) THEN 'OUTBOUND_ASSIGN'
                ELSE 'ORDER_OUT'
              END
          AND (
                public.can_access_wholesaler(o.wholesaler_id)
             OR o.retailer_id = public.get_current_retailer_id()
          )
    )
    SELECT
        s.product_id,
        p.name,
        sc.trace_no,
        s.qty,
        m.grade,
        m.slaughter_date,
        m.butchery_place
    FROM shipped s
    JOIN public.inbound_scans sc ON sc.id = s.inbound_scan_id
    JOIN public.products p       ON p.id = s.product_id
    LEFT JOIN public.master_livestock m ON m.trace_no = sc.trace_no
    ORDER BY 2, 3;
$function$;

-- 출고 라벨 — 반환 열에서 is_bundle·total_weight·source_traces를 뺀다(반환 형식이 바뀌어 DROP 후 다시 만든다).
DROP FUNCTION IF EXISTS public.get_order_labels(uuid);

CREATE FUNCTION public.get_order_labels(p_order_id uuid)
 RETURNS TABLE(product_name text, trace_no text, quantity numeric, unit text, grade text, origin text, slaughter_date date, packing_date date, butchery_place text, supplier_name text, order_number text, retailer_name text, best_before date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        p.name,
        s.trace_no,
        -l.qty_delta,
        COALESCE(s.unit, p.unit),
        COALESCE(m.grade, p.grade),
        p.origin,
        m.slaughter_date,
        m.packing_date,
        m.butchery_place,
        w.business_name,
        o.order_number,
        r.restaurant_name,
        s.best_before
    FROM public.stock_ledger l
    JOIN public.orders o          ON o.id = l.source_id
    JOIN public.wholesalers w     ON w.id = o.wholesaler_id
    JOIN public.retailers r       ON r.id = o.retailer_id
    JOIN public.inbound_scans s   ON s.id = l.inbound_scan_id
    JOIN public.products p        ON p.id = l.product_id
    LEFT JOIN public.master_livestock m  ON m.trace_no = s.trace_no
    WHERE l.source_type = 'order'
      AND l.source_id = p_order_id
      AND l.inbound_scan_id IS NOT NULL
      -- 상품마다 스캔 여부가 다를 수 있어 상품 단위로 판정한다.
      AND l.event_type = CASE
            WHEN EXISTS (
                SELECT 1 FROM public.stock_ledger x
                WHERE x.source_type = 'order' AND x.source_id = p_order_id
                  AND x.event_type = 'OUTBOUND_ASSIGN'
                  AND x.product_id = l.product_id
            ) THEN 'OUTBOUND_ASSIGN'
            ELSE 'ORDER_OUT'
          END
      AND (
            public.can_access_wholesaler(o.wholesaler_id)
      )
    ORDER BY p.name, s.trace_no;
$function$;

-- 재고 원장 요약 — 세트투입 칸(bundle_qty)을 뺀다.
DROP FUNCTION IF EXISTS public.summarize_stock_ledger(uuid, date, date, uuid, text);

CREATE FUNCTION public.summarize_stock_ledger(p_wholesaler_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_trace_no text DEFAULT NULL::text)
 RETURNS TABLE(inbound_qty numeric, outbound_qty numeric, adjustment_qty numeric, loss_qty numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN ('INBOUND', 'INBOUND_VOID', 'OPENING_BALANCE')), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type IN (
            'ORDER_OUT', 'ORDER_RESTORE', 'OUTBOUND_ASSIGN', 'OUTBOUND_UNASSIGN'
        )), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'ADJUSTMENT'), 0),
        COALESCE(SUM(l.qty_delta) FILTER (WHERE l.event_type = 'LOSS'), 0)
    FROM public.stock_ledger l
    LEFT JOIN public.inbound_scans scan ON scan.id = l.inbound_scan_id
    WHERE l.wholesaler_id = p_wholesaler_id
      AND (p_from IS NULL OR l.created_at >= p_from::timestamptz)
      AND (p_to IS NULL OR l.created_at < (p_to + 1)::timestamptz)
      AND (p_product_id IS NULL OR l.product_id = p_product_id)
      AND (
            NULLIF(btrim(p_trace_no), '') IS NULL
         OR scan.trace_no ILIKE '%' || btrim(p_trace_no) || '%'
      )
      AND (
            public.can_access_wholesaler(p_wholesaler_id)
      );
$function$;

-- 3) 세트 표 삭제(자식 → 부모 순) --------------------------------------------------
DROP TABLE IF EXISTS public.bundle_assembly_sources;
DROP TABLE IF EXISTS public.bundle_assemblies;
DROP TABLE IF EXISTS public.product_bundle_items;
DROP TABLE IF EXISTS public.product_bundles;

-- 4) 세트 전용 값 제거 ------------------------------------------------------------
ALTER TABLE public.inbound_scans DROP CONSTRAINT IF EXISTS inbound_scans_scan_type_check;
ALTER TABLE public.inbound_scans
    ADD CONSTRAINT inbound_scans_scan_type_check
    CHECK (scan_type = ANY (ARRAY['BARCODE_SCAN'::text, 'CAMERA'::text, 'EXCEL'::text, 'MANUAL'::text]));

ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_event_type_check;
ALTER TABLE public.stock_ledger
    ADD CONSTRAINT stock_ledger_event_type_check
    CHECK (event_type = ANY (ARRAY[
        'INBOUND'::text, 'INBOUND_VOID'::text, 'OPENING_BALANCE'::text, 'ORDER_OUT'::text, 'ORDER_RESTORE'::text,
        'OUTBOUND_ASSIGN'::text, 'OUTBOUND_UNASSIGN'::text, 'ADJUSTMENT'::text, 'LOSS'::text
    ]));

ALTER TABLE public.stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_source_type_check;
ALTER TABLE public.stock_ledger
    ADD CONSTRAINT stock_ledger_source_type_check
    CHECK (source_type = ANY (ARRAY['inbound_scan'::text, 'order'::text, 'product'::text, 'manual'::text]));

-- 5) 소 정체성 유니크 인덱스에서 세트 제외 조건 제거 ---------------------------------
DROP INDEX IF EXISTS public.idx_products_cattle_identity;

CREATE UNIQUE INDEX idx_products_cattle_identity
    ON public.products (wholesaler_id, COALESCE(subcategory, ''), COALESCE(grade, ''), COALESCE(origin, ''))
    WHERE category = '소';

-- 6) 자동 생성 함수: 동시 생성 충돌 처리에서 세트 제외 조건 제거(121에서 넣었던 것) -----------------
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
            -- 같은 정체성의 상품을 동시에 만들려던 다른 요청이 먼저 만들었다 — 그 상품을 쓴다.
            -- 소 외 축종은 (출처 키, 부위), 소는 (부위, 등급, 원산지)가 정체성이다(idx_products_cattle_identity와 같은 조건).
            SELECT id INTO v_product_id
            FROM public.products
            WHERE wholesaler_id = v_wholesaler_id
              AND category = v_master.species_group
              AND COALESCE(subcategory, '') = COALESCE(v_part_name, '')
              AND (
                  (v_trace_key IS NOT NULL AND trace_key = v_trace_key)
                  OR (v_is_cattle
                      AND COALESCE(grade, '') = COALESCE(v_grade, '')
                      AND COALESCE(origin, '') = COALESCE(v_origin, ''))
              )
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
