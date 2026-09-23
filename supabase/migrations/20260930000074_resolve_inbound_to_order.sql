-- 입고 예외/매핑 대기 박스를 "특정 주문으로 바로 보내기".
--
-- 고객이 미리 요청해서 들어온 박스(공공 API에 없는 공급자 자체 묶음번호 등)를
-- 입고 → 주문 확정 대기 → 출고 스캔, 세 화면을 오가지 않고 입고 화면에서 한 번에
-- 처리한다. resolve_inbound_mapping()과 record_outbound_scan()을 그대로 순서대로
-- 호출만 한다 — 새 재고 로직을 만들지 않고 기존 두 함수를 한 트랜잭션으로 묶는다.
-- 중간에 실패하면(예: 이미 다 채워진 주문) 전체가 롤백되어 상품 지정만 되고
-- 배정은 안 된 반쪽 상태가 남지 않는다.
CREATE OR REPLACE FUNCTION public.resolve_inbound_mapping_to_order(
    p_scan_id    UUID,
    p_product_id UUID,
    p_order_id   UUID,
    p_remember   BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_resolve  JSONB;
    v_outbound JSONB;
    v_scan     public.inbound_scans%ROWTYPE;
BEGIN
    v_resolve := public.resolve_inbound_mapping(p_scan_id, p_product_id, p_remember);

    SELECT * INTO v_scan FROM public.inbound_scans WHERE id = p_scan_id;

    -- p_weight를 생략(NULL)하면 record_outbound_scan이 "박스 잔량과 주문에 필요한
    -- 양 중 작은 쪽"을 알아서 가져간다 — 방금 들어온 박스가 주문보다 커도 문제없다.
    v_outbound := public.record_outbound_scan(p_order_id, v_scan.trace_no, NULL);

    RETURN jsonb_build_object('resolve', v_resolve, 'outbound', v_outbound);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_inbound_mapping_to_order(UUID, UUID, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_inbound_mapping_to_order(UUID, UUID, UUID, BOOLEAN) TO authenticated;
