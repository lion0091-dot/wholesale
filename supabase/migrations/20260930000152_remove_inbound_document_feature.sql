-- 입고 명세서(전표) 구조화·자동추출·대조 화면 기능 전체 제거 (2026-09-28, 사장님 최종 결정).
--
-- 이유: 종이 원본을 실물로 보관할 것이므로 디지털 구조화(자동추출·대조화면·사진 보관 포함)가
-- 재고 정확도에 불필요하다는 판단. 재고·매입금액은 이미 박스 스캔(inbound_scans, 24단계)
-- 기준으로만 계산되고, 발주서-스캔 대조(142)도 명세서 없이 이미 동작한다.
--
-- 남기는 것: 발주서-스캔 대조(judge_scan_purchase_order, 142), 보류함(발주서에 없거나
-- 초과로 받은 박스를 사후에 발주서로 등록하는 create_purchase_order_from_unlisted_scan).
-- 절대 안 건드리는 것: "거래명세서"(출고/판매 쪽 PDF, transaction-statement-pdf 기능) — 이름만
-- 비슷하고 완전히 다른 기능이다.
--
-- 라이브 데이터는 삭제 직전 SELECT로 백업해 두었다(문서 1건·줄 3건·서식 1건, 연결 0건 — 거의 없는 수준).

-- ------------------------------------------------------------------
-- 0) 남겨둔 테이블(inbound_scans)에 걸린 문서 전용 트리거부터 뗀다(테이블 자체는 유지).
-- ------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_unlink_voided_scan ON public.inbound_scans;

-- ------------------------------------------------------------------
-- 1) 문서 전용 함수 전체 삭제.
--    document_line_match_status는 SQL 함수라 document_line_effective_count_mode·
--    document_line_expected_qty를 직접 참조한다 — 그 둘보다 먼저 지운다.
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.document_line_match_status(uuid);
DROP FUNCTION IF EXISTS public.auto_link_scan_to_document_line(uuid);
DROP FUNCTION IF EXISTS public.close_inbound_document(uuid, text);
DROP FUNCTION IF EXISTS public.document_lines_matching_trace(uuid, text);
DROP FUNCTION IF EXISTS public.link_scan_to_document_line(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.list_awaiting_document_line_ids(uuid);
DROP FUNCTION IF EXISTS public.list_unlinked_boxes_for_documents(uuid);
DROP FUNCTION IF EXISTS public.match_document_lines_for_traces(uuid, text[]);
DROP FUNCTION IF EXISTS public.lookup_document_grade(uuid, text);
DROP FUNCTION IF EXISTS public.lookup_document_part_name(uuid, text);
DROP FUNCTION IF EXISTS public.lookup_product_by_document_trace(text);
DROP FUNCTION IF EXISTS public.relink_pending_scans_to_documents();
DROP FUNCTION IF EXISTS public.reopen_inbound_document(uuid);
DROP FUNCTION IF EXISTS public.set_document_line_count_mode(uuid, text);
DROP FUNCTION IF EXISTS public.set_documents_scan_finished(uuid[], boolean);
DROP FUNCTION IF EXISTS public.unlink_scan_from_document_line(uuid);
DROP FUNCTION IF EXISTS public.unlink_voided_scan();
DROP FUNCTION IF EXISTS public.update_inbound_document_line(uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.create_purchase_order_from_document_scan(uuid);
DROP FUNCTION IF EXISTS public.set_document_supplier(uuid, uuid);
-- 이 셋은 inbound_documents의 트리거가 아직 물고 있어(테이블은 다음 단계에서 지운다) CASCADE로
-- 트리거까지 함께 지운다 — 테이블 자체가 곧 없어지므로 트리거만 먼저 없어져도 안전하다.
DROP FUNCTION IF EXISTS public.enforce_inbound_document_discarded_before_delete() CASCADE;
DROP FUNCTION IF EXISTS public.enforce_inbound_document_direct_writes() CASCADE;
DROP FUNCTION IF EXISTS public.unlink_scans_of_discarded_document() CASCADE;
DROP FUNCTION IF EXISTS public.document_line_effective_count_mode(text, numeric, numeric, text, text);
DROP FUNCTION IF EXISTS public.document_line_expected_qty(numeric);
-- 로트(묶음번호) 구성원 조회 — 오직 위에서 지운 문서 대조 함수들만 썼다(다른 곳에서 안 쓰임).
DROP FUNCTION IF EXISTS public.lot_member_trace_nos(text);

-- ------------------------------------------------------------------
-- 2) 문서 전용 테이블 삭제. document_id/line_id 칸에 REFERENCES 제약이 없어(앱 레벨로만
--    묶여 있었다) CASCADE로 자동으로 안 딸려 온다 — 자식부터 순서대로 명시한다.
-- ------------------------------------------------------------------
DROP TABLE IF EXISTS public.inbound_document_line_scans CASCADE;
DROP TABLE IF EXISTS public.inbound_document_lines CASCADE;
DROP TABLE IF EXISTS public.inbound_documents CASCADE;
DROP TABLE IF EXISTS public.supplier_document_formats CASCADE;

-- ------------------------------------------------------------------
-- 3) record_inbound_scan_base — 중복 의심 검사에서 "명세서가 이 번호로 박스 여럿을
--    예고해 자리가 남았으면 통과시키는" 예외만 제거한다. 문서가 없으니 예외 근거도 없다.
--    나머지 본문은 로컬 DB의 pg_get_functiondef 결과를 그대로 옮겼다(079 방식).
-- ------------------------------------------------------------------
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

-- ------------------------------------------------------------------
-- 4) autocreate_product_for_scan — 이력조회가 부위·등급을 못 주면 예전엔 명세서
--    줄에서 딱 하나로 좁혀지는 값으로 채웠다. 명세서가 없으니 그 보조 경로를 없애고
--    이력조회 값만 쓴다(못 채우면 예전처럼 "(부위 미지정)"으로 남긴다).
-- ------------------------------------------------------------------
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

    -- 부위·등급은 이력조회 값만 쓴다. 못 채우면 비워서 "(부위 미지정)"으로 남긴다.
    v_part_name := NULLIF(btrim(COALESCE(v_master.part_name, '')), '');
    v_grade := NULLIF(btrim(COALESCE(v_master.grade, '')), '');

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
                       THEN ' — 이력조회에 부위가 없어 비워두었습니다. 채워주세요.'
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

-- ------------------------------------------------------------------
-- 5) create_purchase_order_from_unlisted_scan — 보류함의 "발주서 추가 생성"에서
--    전표까지 같이 만들던 부분만 제거한다. 발주서 생성(create_retroactive_purchase_order
--    호출)은 그대로 유지 — 보류함 기능 자체는 남긴다.
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
    v_result    JSONB;
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

    v_result := public.create_retroactive_purchase_order(p_scan_id, v_scan.supplier_id, v_scan.created_at::date);

    RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_purchase_order_from_unlisted_scan(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase_order_from_unlisted_scan(UUID) TO authenticated;
