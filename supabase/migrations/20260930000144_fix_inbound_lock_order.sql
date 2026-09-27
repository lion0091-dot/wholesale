-- 통단 감사(2026-09-27)에서 발견한 교착(deadlock) 가능성 수정.
--
-- void_inbound_scan(박스 취소, 000053)과 judge_scan_purchase_order(142)가 products·purchase_orders
-- 잠금 순서가 서로 반대였다: judge_scan_purchase_order는 scan→product→purchase_orders 순으로 잠그지만,
-- void_inbound_scan은 scan을 잠근 뒤 상태를 VOIDED로 바꾸는 UPDATE가 트리거
-- (release_voided_scan_from_purchase_order)를 태워 purchase_orders를 먼저 잠그고, 그 다음에야
-- recalc_product_stock으로 products를 잠갔다(scan→purchase_orders→product).
-- 같은 상품·발주서를 두고 "박스 취소"와 "새 박스 스캔"이 동시에 일어나면 서로 반대 순서로 기다려
-- 40P01 deadlock detected가 날 수 있었다.
--
-- 수정: void_inbound_scan도 scan을 잠근 즉시(트리거를 태우는 UPDATE보다 먼저) products를 잠가
-- 099에서 정한 "박스→상품" 원칙 + judge_scan_purchase_order와 같은 순서(scan→product→purchase_orders)로
-- 통일한다. 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로, products 잠금 한 줄만 더했다.
CREATE OR REPLACE FUNCTION public.void_inbound_scan(p_scan_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_wholesaler_id UUID;
    v_scan          public.inbound_scans%ROWTYPE;
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

    IF v_scan.status = 'VOIDED' THEN
        RAISE EXCEPTION 'ALREADY_VOIDED';
    END IF;

    -- judge_scan_purchase_order와 잠금 순서를 맞추기 위해, purchase_orders를 건드리는
    -- 트리거(release_voided_scan_from_purchase_order)를 태우기 전에 products를 먼저 잠근다.
    IF v_scan.product_id IS NOT NULL THEN
        PERFORM 1 FROM public.products WHERE id = v_scan.product_id FOR UPDATE;
    END IF;

    IF v_scan.status = 'NORMAL' THEN
        IF v_scan.remaining_weight <> v_scan.weight THEN
            RAISE EXCEPTION 'PARTIALLY_SHIPPED';
        END IF;

        INSERT INTO public.stock_ledger (
            wholesaler_id, product_id, inbound_scan_id, qty_delta,
            event_type, source_type, source_id, reason, created_by
        ) VALUES (
            v_wholesaler_id, v_scan.product_id, p_scan_id, -v_scan.weight,
            'INBOUND_VOID', 'inbound_scan', p_scan_id, p_reason, auth.uid()
        );
    END IF;

    UPDATE public.inbound_scans
    SET status = 'VOIDED',
        remaining_weight = 0,
        memo = COALESCE(p_reason, memo)
    WHERE id = p_scan_id;

    IF v_scan.product_id IS NOT NULL THEN
        PERFORM public.recalc_product_stock(v_scan.product_id);
    END IF;

    UPDATE public.livestock_exception_log
    SET resolved_status = 'DISCARDED',
        resolved_by = auth.uid(),
        resolved_at = now()
    WHERE inbound_scan_id = p_scan_id AND resolved_status = 'PENDING';

    RETURN jsonb_build_object('scan_id', p_scan_id, 'status', 'VOIDED');
END;
$function$;
