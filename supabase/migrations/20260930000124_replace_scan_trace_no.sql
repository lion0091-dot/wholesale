-- 이력조회에 실패했거나 상품이 안 정해진 박스의 이력번호를 그 자리에서 바로잡거나 다시 조회한다. (사장님 2026-09-26)
--
-- 지금까지는 번호가 틀리면 박스를 취소하고 실중량·보관위치·유통기한을 다시 넣어 새로 찍어야 했고,
-- 이력조회가 늦게 등록된 번호는 다시 조회할 방법이 없었다.
--
-- 재고 규칙(잠긴 결정)은 그대로다: 이 함수는 재고에 안 들어간 박스(EXCEPTION·PENDING_MAPPING)만 다룬다.
-- 재고에 이미 들어간 박스(NORMAL)는 번호를 못 바꾼다 — 원장·출고 기록이 그 번호에 걸려 있다.
--
-- 방식: 옛 박스를 취소(VOIDED)하고 같은 실중량으로 새 번호를 다시 기록한 뒤, 사람이 넣은 값(표기중량·유통기한·
-- 매입단가·상품코드·보관위치·찍은 시각)을 새 박스로 옮긴다. 한 트랜잭션이라 중간에 실패하면(중복 의심 등) 옛 박스가 그대로 남는다.
-- 옛 박스의 memo에 "이력번호 정정: 옛 → 새"가 남아 누가 무엇을 바꿨는지 추적된다.

ALTER TABLE public.inbound_scans ADD COLUMN IF NOT EXISTS lookup_retried_at TIMESTAMPTZ;

COMMENT ON COLUMN public.inbound_scans.lookup_retried_at IS
    '자동 재조회를 마지막으로 시도한 시각(이력조회 실패 박스만). 30분 안에 또 조회하지 않게 한다.';

CREATE OR REPLACE FUNCTION public.replace_inbound_scan_trace_no(
    p_scan_id uuid,
    p_new_trace_no text,
    p_fail_reason text DEFAULT NULL,
    p_fail_detail text DEFAULT NULL,
    p_confirm_duplicate boolean DEFAULT false
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_old           public.inbound_scans%ROWTYPE;
    v_new_no        TEXT;
    v_result        JSONB;
    v_new_id        UUID;
    v_new           public.inbound_scans%ROWTYPE;
    v_default       public.product_purchase_prices%ROWTYPE;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    SELECT * INTO v_old
    FROM public.inbound_scans
    WHERE id = p_scan_id AND wholesaler_id = v_wholesaler_id
    FOR UPDATE;

    IF v_old.id IS NULL THEN
        RAISE EXCEPTION 'SCAN_NOT_FOUND';
    END IF;

    IF v_old.status NOT IN ('EXCEPTION', 'PENDING_MAPPING') THEN
        RAISE EXCEPTION 'SCAN_NOT_EDITABLE';
    END IF;

    v_new_no := upper(btrim(COALESCE(p_new_trace_no, '')));

    IF v_new_no = '' THEN
        RAISE EXCEPTION 'EMPTY_TRACE_NO';
    END IF;

    PERFORM public.void_inbound_scan(
        p_scan_id,
        CASE WHEN v_new_no = upper(v_old.trace_no)
             THEN '이력 재조회'
             ELSE '이력번호 정정: ' || v_old.trace_no || ' → ' || v_new_no
        END
    );

    -- 새 번호로 다시 기록한다. 상품 결정(학습된 매핑)·재고 반영·예외 기록은 원래 스캔과 같은 경로다.
    v_result := public.record_inbound_scan_base(
        v_new_no, v_old.weight, v_old.scan_type, NULL,
        p_fail_reason, NULL, v_old.memo, p_confirm_duplicate, p_fail_detail
    );

    v_new_id := NULLIF(v_result ->> 'scan_id', '')::UUID;

    IF v_new_id IS NULL THEN
        RAISE EXCEPTION 'REPLACE_FAILED';
    END IF;

    SELECT * INTO v_new FROM public.inbound_scans WHERE id = v_new_id;

    IF v_new.product_id IS NOT NULL THEN
        SELECT * INTO v_default FROM public.product_purchase_prices WHERE product_id = v_new.product_id;
    END IF;

    UPDATE public.inbound_scans
    SET labeled_weight              = v_old.labeled_weight,
        best_before                 = v_old.best_before,
        purchase_unit_price         = COALESCE(v_old.purchase_unit_price, v_default.unit_price),
        purchase_supplier           = COALESCE(v_old.purchase_supplier, v_default.supplier_name),
        gtin                        = v_old.gtin,
        storage_location            = v_old.storage_location,
        storage_location_photo_path = v_old.storage_location_photo_path,
        unit                        = v_old.unit,
        scanned_by                  = v_old.scanned_by,
        created_at                  = v_old.created_at
    WHERE id = v_new_id;

    RETURN v_result || jsonb_build_object('old_scan_id', p_scan_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.replace_inbound_scan_trace_no(uuid, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_inbound_scan_trace_no(uuid, text, text, text, boolean) TO authenticated;


-- 자동 재조회 대상에 "시도했다"고 표시한다 — 같은 실패 박스를 30분 안에 또 조회하지 않게 한다(정부 API 호출 한도 보호).
CREATE OR REPLACE FUNCTION public.touch_scan_lookup_retry(p_scan_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_count         INT;
BEGIN
    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RAISE EXCEPTION 'NOT_A_SUPPLIER';
    END IF;

    UPDATE public.inbound_scans
    SET lookup_retried_at = now()
    WHERE id = ANY (COALESCE(p_scan_ids, '{}'::uuid[]))
      AND wholesaler_id = v_wholesaler_id
      AND status = 'EXCEPTION';

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.touch_scan_lookup_retry(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_scan_lookup_retry(uuid[]) TO authenticated;
