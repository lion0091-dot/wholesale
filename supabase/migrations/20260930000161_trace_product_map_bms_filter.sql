-- ====================================================================
-- trace_product_map 학습 매핑이 BMS를 안 보던 버그 수정 (통단테 발견, 2026-09-30)
--
-- 159에서 소 1++ 등급에 BMS(마블링 세부점수 7/8/9)를 조건부 정체성 키로 추가하면서,
-- 주석은 "원산지·BMS는 품종과 같은 방식으로 products 테이블 조인 검사로 거른다"고
-- 적어놨지만 실제 record_inbound_scan_base()의 WHERE절에는 BMS 비교 조건이
-- 빠져 있었다(원산지·성별·품종은 다 있는데 BMS만 없음).
--
-- 실제 증상: 같은 부위·등급·성별의 1++ 소를 BMS9/BMS7로 나눠 별도 상품을
-- 만들어둔 상태(원가가 달라 의도된 설계)에서, BMS9 상품으로 스캔 한 번 학습시키면
-- 이후 BMS7 박스가 와도 같은 학습 키(species_group+part_name+grade+breed+sex)에
-- 걸려 자동으로 BMS9 상품에 잘못 배정됨 — BMS를 별도 상품으로 나눈 목적 자체가 무력화됨.
--
-- BMS는 성별과 같은 원칙(COALESCE 비교, 모르면 매핑 허용)을 따른다 — 1++가 아니면
-- 애초에 BMS를 안 쓰므로 검사를 건너뛴다.
--
-- 함수 본문은 로컬 DB의 pg_get_functiondef(159 적용 후) 기준으로 패치했다(079 방식).
-- ====================================================================

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
        -- 소는 원산지·성별도 정체성 키라(lib/products/identity-key.ts) 학습된 매핑이 다른 원산지·성별의 상품으로 새지 않게 거른다.
        SELECT m.product_id INTO v_product_id
        FROM public.trace_product_map m
        JOIN public.products p ON p.id = m.product_id
        WHERE m.wholesaler_id = v_wholesaler_id
          AND m.species_group = v_master.species_group
          AND m.part_name = v_master.part_name
          AND (m.grade IS NULL OR m.grade = v_master.grade)
          -- 소는 품종(한우/육우/젖소)도 정체성 키라 다른 품종의 상품으로 새지 않게 거른다. 이력조회가 품종을 못 주면 매핑하지 않는다(사무실이 고른다).
          AND (v_master.species_group <> '소' OR (p.breed IS NOT NULL AND p.breed = public.trace_breed(v_master.species)))
          -- 소는 성별도 정체성 키다(2026-09-30). 품종과 달리 성별은 모를 때 매핑을 막지
          -- 않는다 — 양쪽 다 비어있는("성별 미지정" 상품 ↔ 이력조회가 성별을 안 준 경우)
          -- 매핑은 허용한다(COALESCE 비교, autocreate_product_for_scan과 같은 원칙).
          AND (v_master.species_group <> '소' OR COALESCE(p.sex, '') = COALESCE(v_master.sex, ''))
          -- 소 1++ 등급은 BMS도 정체성 키다(2026-09-30, 이 마이그레이션으로 추가) — 등급이
          -- 1++가 아니면 애초에 BMS를 안 쓰므로 검사를 건너뛰고, 1++일 때만 COALESCE로
          -- 비교한다(성별과 같은 원칙: 모르면 매핑 허용). 이게 빠져 있어서 BMS9으로 학습한
          -- 매핑이 BMS7 박스에도 그대로 걸리던 버그가 있었다.
          AND (
                v_master.species_group <> '소' OR v_master.grade IS DISTINCT FROM '1++'
                OR COALESCE(p.bms, '') = COALESCE(v_master.bms, '')
          )
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
