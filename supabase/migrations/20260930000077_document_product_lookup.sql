-- 명세서에서 지정한 상품을 스캔이 물려받는다 (30단계)
--
-- 지금까지 상품이 정해지는 경로는 둘이었다:
--   1. trace_product_map — 축종+부위+등급 학습. 이력조회가 부위를 주지 않아
--      실질적으로 거의 안 걸린다(30단계에서 확인).
--   2. gtin_product_map — 바코드 상품코드 학습. 라벨에 GS1 코드가 있어야 한다.
--
-- 셋째 경로를 추가한다. **명세서 줄에서 사람이 직접 지목한 상품**이다. 명세서를
-- 먼저 올려두고 현장에서 찍는 흐름에서는 이게 제일 확실하다 — 추측이 아니라
-- 사람이 그 이력번호를 보고 고른 값이기 때문이다. 그러면 명세서를 올려둔 물건은
-- 찍기만 하면 상품 확정까지 끝난다(사장님 요청).
--
-- **애매하면 자동으로 고르지 않는다.** 같은 이력번호가 한 명세서 안에서 등심과
-- 안심 두 줄로 나뉘어 있을 수 있다(한 마리에서 여러 부위가 나오므로 정상이다).
-- 그 경우 어느 쪽인지는 박스를 열어봐야 알 수 있으므로 사람에게 되묻는다 —
-- 하나로 딱 떨어질 때만 자동 확정한다.

CREATE OR REPLACE FUNCTION public.lookup_product_by_document_trace(p_trace_no TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wholesaler_id UUID;
    v_product_id    UUID;
    v_distinct      INT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    v_wholesaler_id := public.resolve_current_wholesaler_id();

    IF v_wholesaler_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- 서로 다른 상품이 몇 개나 걸리는지 먼저 센다.
    SELECT count(DISTINCT l.product_id) INTO v_distinct
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    JOIN public.products p          ON p.id = l.product_id
    WHERE d.wholesaler_id = v_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND l.trace_no = btrim(p_trace_no)
      AND l.product_id IS NOT NULL
      -- 보관해 치운 상품에는 재고를 다시 붙이지 않는다.
      AND p.archived_at IS NULL;

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    SELECT DISTINCT l.product_id INTO v_product_id
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    JOIN public.products p          ON p.id = l.product_id
    WHERE d.wholesaler_id = v_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND l.trace_no = btrim(p_trace_no)
      AND l.product_id IS NOT NULL
      AND p.archived_at IS NULL;

    RETURN v_product_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.lookup_product_by_document_trace(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_product_by_document_trace(TEXT) TO authenticated;

COMMENT ON FUNCTION public.lookup_product_by_document_trace(TEXT) IS
    '명세서 줄에서 사람이 지목한 상품. 같은 이력번호에 서로 다른 상품이 걸리면 NULL(되묻는다).';
