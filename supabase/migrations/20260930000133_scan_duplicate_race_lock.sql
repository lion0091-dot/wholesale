-- 같은 박스가 동시에 두 번 들어와 재고가 두 배가 되는 것을 막는다. (사장님 요청 "입고 스캔 전 케이스 점검", 2026-09-26)
--
-- 재현: 같은 번호·같은 무게 스캔 2건을 동시에 보내면 둘 다 중복 검사(과거 10분 안의 같은 박스 조회)를 통과해 박스가 2개 생겼다.
-- 조치: record_inbound_scan_base 맨 앞에서 (업체, 번호) 단위 어드바이저리 락을 잡는다. 그 밖의 본문은 로컬 DB의 현재 정의(pg_get_functiondef) 그대로다.
-- 자리 남음 예외: 아직 줄에 이어지지 않은 같은 번호 박스도 센다(락만으로는 첫 박스의 '이어짐'이 끝나기 전 둘째 요청이 통과했다).
-- 락 순서: 이 락이 함수에서 가장 먼저 잡히는 락이고 다른 함수는 이 락을 안 잡아 교착이 생기지 않는다(번호 교체는 옛 박스 행 잠금 뒤 여기로 오지만 새 번호는 다른 박스 행을 기다리지 않는다).

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
