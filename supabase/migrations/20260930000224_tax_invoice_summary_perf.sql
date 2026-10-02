-- 계산서 집계 월별·거래처별(222) 성능 보강 (2026-10-03) — 결과는 같고 쿼리 모양만 바꾼다.
--   대량 입력 직후(통계 없음) 발행이력 5,500건·주문 6,000건에서 1.3초가 걸렸다: 계획기가 발행이력마다 그 업체의 주문 전체(수천 건)를
--   훑는 중첩 루프를 골랐기 때문이다. 이력마다 주문을 기본키로 한 건씩 찾도록 LATERAL ... OFFSET 0 로 고정하고(업체 조건은 찾은 뒤에 건다 — 안 그러면 통계가 낡았을 때 업체 인덱스를 골라 다시 느려진다)  통계와 무관하게 선형으로 만든다.
--   (OFFSET 0 은 계획기가 이 부분 쿼리를 바깥에 합쳐 다시 잘못된 순서를 고르는 것을 막는다.)

-- 월별. issued_* = 발행 완료한 최초 발행, corrected_count = 발행 완료한 정정 발행 건수.
CREATE OR REPLACE FUNCTION public.get_tax_invoice_by_month(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
    month_start     date,
    issued_count    integer,
    issued_amount   numeric,
    corrected_count integer,
    pending_count   integer,
    failed_count    integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid  uuid;
    v_from timestamptz;
    v_to   timestamptz;
BEGIN
    SELECT s.o_wid, s.o_from, s.o_to INTO v_wid, v_from, v_to FROM public.resolve_tax_invoice_scope(p_from, p_to) s;

    RETURN QUERY
    SELECT date_trunc('month', COALESCE(t.issued_at, t.created_at) AT TIME ZONE 'Asia/Seoul')::date AS m,
           (count(*) FILTER (WHERE t.status = 'issued' AND t.original_issuance_id IS NULL AND t.modify_code IS NULL))::integer,
           COALESCE(sum(o.total_amount) FILTER (WHERE t.status = 'issued' AND t.original_issuance_id IS NULL AND t.modify_code IS NULL), 0),
           (count(*) FILTER (WHERE t.status = 'issued' AND (t.original_issuance_id IS NOT NULL OR t.modify_code IS NOT NULL)))::integer,
           (count(*) FILTER (WHERE t.status = 'pending'))::integer,
           (count(*) FILTER (WHERE t.status = 'failed'))::integer
    FROM public.tax_invoice_issuances t
    JOIN LATERAL (
        SELECT o1.id, o1.total_amount, o1.retailer_id, o1.wholesaler_id
        FROM public.orders o1 WHERE o1.id = t.order_id
        OFFSET 0
    ) o ON true
    WHERE t.wholesaler_id = v_wid
      AND o.wholesaler_id = v_wid
      AND t.status <> 'cancelled'
      AND COALESCE(t.issued_at, t.created_at) >= v_from AND COALESCE(t.issued_at, t.created_at) < v_to
    GROUP BY 1
    ORDER BY 1 DESC;
END;
$$;

-- 거래처별(발행 완료 금액 큰 순). 거래처 이름은 retailers.restaurant_name.
CREATE OR REPLACE FUNCTION public.get_tax_invoice_by_retailer(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
    retailer_id     uuid,
    retailer_name   text,
    issued_count    integer,
    issued_amount   numeric,
    corrected_count integer,
    pending_count   integer,
    failed_count    integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid  uuid;
    v_from timestamptz;
    v_to   timestamptz;
BEGIN
    SELECT s.o_wid, s.o_from, s.o_to INTO v_wid, v_from, v_to FROM public.resolve_tax_invoice_scope(p_from, p_to) s;

    RETURN QUERY
    SELECT o.retailer_id,
           COALESCE(r.restaurant_name, '알 수 없음')::text,
           (count(*) FILTER (WHERE t.status = 'issued' AND t.original_issuance_id IS NULL AND t.modify_code IS NULL))::integer,
           COALESCE(sum(o.total_amount) FILTER (WHERE t.status = 'issued' AND t.original_issuance_id IS NULL AND t.modify_code IS NULL), 0),
           (count(*) FILTER (WHERE t.status = 'issued' AND (t.original_issuance_id IS NOT NULL OR t.modify_code IS NOT NULL)))::integer,
           (count(*) FILTER (WHERE t.status = 'pending'))::integer,
           (count(*) FILTER (WHERE t.status = 'failed'))::integer
    FROM public.tax_invoice_issuances t
    JOIN LATERAL (
        SELECT o1.id, o1.total_amount, o1.retailer_id, o1.wholesaler_id
        FROM public.orders o1 WHERE o1.id = t.order_id
        OFFSET 0
    ) o ON true
    LEFT JOIN public.retailers r ON r.id = o.retailer_id
    WHERE t.wholesaler_id = v_wid
      AND o.wholesaler_id = v_wid
      AND t.status <> 'cancelled'
      AND COALESCE(t.issued_at, t.created_at) >= v_from AND COALESCE(t.issued_at, t.created_at) < v_to
    GROUP BY o.retailer_id, r.restaurant_name
    ORDER BY 4 DESC, 2;
END;
$$;
