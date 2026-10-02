-- 계산서 집계 탭(222)의 "챙겨야 할 주문" 목록 (2026-10-03) — 조회 전용, 새 표 없음. 접근·기간 검사는 222의 resolve_tax_invoice_scope 그대로.
--
--   kind = 'pending' : 결과를 모르는 발행(국세청 접수 여부 확인 필요) — 정정 발행 포함. 팝빌에서 확인해 정리하기 전까지 같은 주문 재발행이 막힌다(109).
--   kind = 'failed'  : 실패한 발행 중, 그 뒤에 같은 주문의 발행(진행 중·완료)이 생기지 않은 것 — 다시 발행하면 사라진다.
--   kind = 'missing' : 기간 안에 출고 확정된(취소 제외) 주문 중 발행이력이 하나도 없는 것(취소된 이력은 없는 것으로 본다).
--   기준일: pending·failed = 이력을 만든 시각, missing = 출고 확정 시각(한국 시간, 끝 날짜 포함).
--   성능: 발행이력마다 주문을 기본키로 한 건씩 찾는다(LATERAL ... OFFSET 0). 통계가 없는 대량 입력 직후에 계획기가 주문 목록 전체를 이력마다 훑는
--   중첩 루프를 고르는 것을 막는다(224와 같은 이유).
--   "뒤에 발행이 있나·이력이 있나" 확인은 업체 조건 없이 주문 번호(order_id 인덱스)로만 찾는다 — 같은 주문의 이력은 같은 업체 것이고(마이그 200 가드),
--   업체 조건을 같이 걸면 통계가 낡았을 때 업체 인덱스로 이력 전체를 주문마다 훑는다.
--   목록은 최대 300건(오래된 것부터가 아니라 최근 것부터), total_count = 상한 적용 전 전체 건수.

DROP FUNCTION IF EXISTS public.get_tax_invoice_todo(date, date);

CREATE FUNCTION public.get_tax_invoice_todo(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (
    kind           text,
    order_id       uuid,
    order_number   text,
    retailer_name  text,
    total_amount   numeric,
    happened_at    timestamptz,
    error_message  text,
    total_count    bigint
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
    WITH attention AS (
        SELECT CASE t.status WHEN 'pending' THEN 'pending' ELSE 'failed' END AS kind,
               o.id AS order_id, o.order_number::text AS order_number,
               COALESCE(r.restaurant_name, '알 수 없음')::text AS retailer_name,
               o.total_amount, t.created_at AS happened_at, t.error_message::text AS error_message
        FROM public.tax_invoice_issuances t
        JOIN LATERAL (
            SELECT o1.id, o1.order_number, o1.total_amount, o1.retailer_id, o1.wholesaler_id
            FROM public.orders o1 WHERE o1.id = t.order_id
            OFFSET 0
        ) o ON true
        LEFT JOIN public.retailers r ON r.id = o.retailer_id
        WHERE t.wholesaler_id = v_wid
          AND o.wholesaler_id = v_wid
          AND t.created_at >= v_from AND t.created_at < v_to
          AND (
                t.status = 'pending'
                OR (t.status = 'failed' AND NOT EXISTS (
                        SELECT 1 FROM public.tax_invoice_issuances n
                         WHERE n.order_id = t.order_id
                           AND n.status IN ('pending', 'issued') AND n.created_at > t.created_at))
              )
        UNION ALL
        SELECT 'missing', o.id, o.order_number::text, COALESCE(r.restaurant_name, '알 수 없음')::text,
               o.total_amount, o.shipment_finalized_at, NULL::text
        FROM public.orders o
        LEFT JOIN public.retailers r ON r.id = o.retailer_id
        WHERE o.wholesaler_id = v_wid
          AND o.shipment_finalized_at >= v_from AND o.shipment_finalized_at < v_to
          AND o.status <> 'cancelled'
          AND NOT EXISTS (
                SELECT 1 FROM public.tax_invoice_issuances n
                 WHERE n.order_id = o.id AND n.status IN ('pending', 'issued', 'failed'))
    )
    SELECT a.kind, a.order_id, a.order_number, a.retailer_name, a.total_amount, a.happened_at, a.error_message,
           count(*) OVER ()
    FROM attention a
    ORDER BY CASE a.kind WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, a.happened_at DESC, a.order_id
    LIMIT 300;
END;
$$;

REVOKE ALL ON FUNCTION public.get_tax_invoice_todo(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tax_invoice_todo(date, date) TO authenticated, service_role;
