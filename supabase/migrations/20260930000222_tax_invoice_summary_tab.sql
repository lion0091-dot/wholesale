-- 회계 관리 > "계산서 집계" 탭 (2026-10-03) — 조회 전용. 새 표는 없다. 발행이력(tax_invoice_issuances 033)을 기간으로 모아 보여준다.
--
--   기준일  = 발행 성공은 발행 시각(issued_at), 그 밖의 상태(진행 중·실패·취소)는 이력을 만든 시각(created_at) — 한국 시간, 끝 날짜 포함.
--   금액    = 계산서 금액은 주문 총액(orders.total_amount, 팝빌 발행 때 넘기는 공급가액 합계와 같다).
--             최초 발행만 금액에 합친다. 정정 발행은 같은 주문을 다시 신고하는 것이라 합치면 두 번 세어지므로 건수만 따로 센다.
--   상태    = 발행 완료(issued) / 진행 중(pending, 결과를 모르는 것) / 실패(failed) / 취소(cancelled)
--   취소(cancelled)는 건수·금액에 넣지 않는다 — 신고가 취소된 계산서다.
-- 접근: 발행·조회 권한과 같은 대표·매니저(can_manage_wholesaler, 109). 직원은 제외. 최대 366일.
-- 회계 관리의 자식 기능 accounting_tax_invoices(기본 켜짐)로 업체별로 켜고 끈다(217 구조).

INSERT INTO public.platform_features (key, label, description, default_enabled, parent_key) VALUES
    ('accounting_tax_invoices', '회계 관리 · 계산서 집계',
     '기간별로 발행한 계산서(면세)의 건수·금액을 월별·거래처별로 모아 보는 탭입니다(대표·매니저). 발행이 안 끝난 건과 실패한 건도 따로 보여줍니다.',
     true, 'accounting')
ON CONFLICT (key) DO NOTHING;

SELECT public.open_default_feature_periods('accounting_tax_invoices');

DROP FUNCTION IF EXISTS public.get_tax_invoice_by_month(date, date);
DROP FUNCTION IF EXISTS public.get_tax_invoice_by_retailer(date, date);

-- 접근 검사 + 기간 해석 한 곳. 통과하면 업체 id와 [시작, 끝) 시각을 돌려준다.
CREATE OR REPLACE FUNCTION public.resolve_tax_invoice_scope(p_from date, p_to date, OUT o_wid uuid, OUT o_from timestamptz, OUT o_to timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
    v_from  date := COALESCE(p_from, date_trunc('month', v_today)::date);
    v_to    date := COALESCE(p_to, v_today);
BEGIN
    o_wid := public.resolve_current_wholesaler_id();

    IF o_wid IS NULL OR NOT public.can_manage_wholesaler(o_wid) THEN
        RAISE EXCEPTION 'NOT_MANAGER';
    END IF;

    IF NOT public.feature_effective(o_wid, 'accounting_tax_invoices') THEN
        RAISE EXCEPTION 'FEATURE_DISABLED';
    END IF;

    IF v_from > v_to THEN
        RAISE EXCEPTION 'INVALID_RANGE';
    END IF;

    IF v_to - v_from > 366 THEN
        RAISE EXCEPTION 'RANGE_TOO_LONG';
    END IF;

    o_from := v_from::timestamp AT TIME ZONE 'Asia/Seoul';
    o_to := (v_to + 1)::timestamp AT TIME ZONE 'Asia/Seoul';
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_tax_invoice_scope(date, date) FROM PUBLIC, anon, authenticated;

-- 월별. issued_* = 발행 완료한 최초 발행, corrected_count = 발행 완료한 정정 발행 건수.
CREATE FUNCTION public.get_tax_invoice_by_month(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
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
    JOIN public.orders o ON o.id = t.order_id AND o.wholesaler_id = v_wid
    WHERE t.wholesaler_id = v_wid
      AND t.status <> 'cancelled'
      AND COALESCE(t.issued_at, t.created_at) >= v_from AND COALESCE(t.issued_at, t.created_at) < v_to
    GROUP BY 1
    ORDER BY 1 DESC;
END;
$$;

-- 거래처별(발행 완료 금액 큰 순). 거래처 이름은 retailers.restaurant_name.
CREATE FUNCTION public.get_tax_invoice_by_retailer(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
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
    JOIN public.orders o ON o.id = t.order_id AND o.wholesaler_id = v_wid
    LEFT JOIN public.retailers r ON r.id = o.retailer_id
    WHERE t.wholesaler_id = v_wid
      AND t.status <> 'cancelled'
      AND COALESCE(t.issued_at, t.created_at) >= v_from AND COALESCE(t.issued_at, t.created_at) < v_to
    GROUP BY o.retailer_id, r.restaurant_name
    ORDER BY 4 DESC, 2;
END;
$$;

REVOKE ALL ON FUNCTION public.get_tax_invoice_by_month(date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_tax_invoice_by_retailer(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tax_invoice_by_month(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tax_invoice_by_retailer(date, date) TO authenticated, service_role;
