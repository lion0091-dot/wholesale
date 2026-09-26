-- 전표 줄 "무게 기준" 판정의 허용 오차를 업체별로 설정한다. (사장님 2026-09-26: "오차는 업체에서 설정")
--
-- 지금까지는 ±2% 고정(inbound_weight_tolerance())이었다. 공급처 표기 무게와 저울이 자주 어긋나는 업체는 사무실에 남는 전표가 늘어나므로
-- 업체가 0.5% ~ 20% 사이에서 정한다. 기본값 2%라 적용만으로는 화면이 안 바뀐다.
-- 이 값은 전표 줄의 도착 판정(document_line_match_status)에만 쓴다. 입고 검수의 표기중량↔실중량 경고(±2%)는 별개라 그대로다.

ALTER TABLE public.wholesalers
    ADD COLUMN IF NOT EXISTS weight_tolerance_percent NUMERIC(4, 1) NOT NULL DEFAULT 2.0
    CHECK (weight_tolerance_percent >= 0.5 AND weight_tolerance_percent <= 20);

COMMENT ON COLUMN public.wholesalers.weight_tolerance_percent IS
    '전표 줄 무게 기준 판정 허용 오차(%). 표기중량 대비 이어진 박스 무게 합이 이 범위 안이면 다 온 것으로 본다.';

-- 읽기: 그 업체 직원이면 누구나(화면·자동 마감이 판정에 쓴다). 반환은 비율(0.02).
CREATE OR REPLACE FUNCTION public.get_weight_tolerance(p_wholesaler_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN NULL;
    END IF;

    RETURN (SELECT weight_tolerance_percent / 100.0 FROM public.wholesalers WHERE id = p_wholesaler_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_weight_tolerance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_weight_tolerance(uuid) TO authenticated;

-- 쓰기: 사장·매니저만(매출 정책과 같은 기준).
CREATE OR REPLACE FUNCTION public.set_weight_tolerance_percent(p_wholesaler_id uuid, p_percent numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.can_manage_wholesaler(p_wholesaler_id) THEN
        RAISE EXCEPTION 'FORBIDDEN';
    END IF;

    IF p_percent IS NULL OR p_percent < 0.5 OR p_percent > 20 THEN
        RAISE EXCEPTION 'INVALID_TOLERANCE';
    END IF;

    UPDATE public.wholesalers SET weight_tolerance_percent = round(p_percent, 1) WHERE id = p_wholesaler_id;

    RETURN (SELECT weight_tolerance_percent FROM public.wholesalers WHERE id = p_wholesaler_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.set_weight_tolerance_percent(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_weight_tolerance_percent(uuid, numeric) TO authenticated;

-- 판정 함수: 고정 ±2% 대신 그 전표를 가진 업체의 설정을 쓴다(반환 열은 123과 같다).
CREATE OR REPLACE FUNCTION public.document_line_match_status(p_line_id uuid)
 RETURNS TABLE (
    expected integer, linked integer, status text,
    mode text, expected_weight numeric, linked_weight numeric, linked_boxes integer
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    WITH l AS (
        SELECT x.quantity, x.labeled_weight,
               public.document_line_effective_count_mode(x.count_mode, x.quantity, x.labeled_weight, x.trace_no, x.raw_text) AS mode,
               COALESCE(w.weight_tolerance_percent / 100.0, 0.02) AS tol
        FROM public.inbound_document_lines x
        JOIN public.inbound_documents d ON d.id = x.document_id
        JOIN public.wholesalers w ON w.id = d.wholesaler_id
        WHERE x.id = p_line_id
    ),
    n AS (
        SELECT count(*)::int AS boxes, COALESCE(sum(s.weight), 0) AS wsum
        FROM public.inbound_document_line_scans ls
        JOIN public.inbound_scans s ON s.id = ls.scan_id
        WHERE ls.line_id = p_line_id AND s.status <> 'VOIDED'
    ),
    w AS (
        SELECT l.mode, l.quantity, l.labeled_weight, n.boxes, n.wsum,
               CASE
                   WHEN l.mode <> 'WEIGHT' THEN NULL
                   WHEN n.boxes = 0 THEN 'AWAITING'
                   WHEN n.wsum < l.labeled_weight * (1 - l.tol) THEN 'PARTIAL'
                   WHEN n.wsum <= l.labeled_weight * (1 + l.tol) THEN 'COMPLETE'
                   ELSE 'OVER'
               END AS wstatus
        FROM l, n
    )
    SELECT
        CASE WHEN w.mode = 'WEIGHT' THEN 1 ELSE public.document_line_expected_qty(w.quantity) END,
        CASE WHEN w.mode = 'WEIGHT'
             THEN CASE w.wstatus WHEN 'COMPLETE' THEN 1 WHEN 'OVER' THEN 2 ELSE 0 END
             ELSE w.boxes
        END,
        CASE WHEN w.mode = 'WEIGHT' THEN w.wstatus
             WHEN w.boxes = 0 THEN 'AWAITING'
             WHEN w.boxes < public.document_line_expected_qty(w.quantity) THEN 'PARTIAL'
             WHEN w.boxes = public.document_line_expected_qty(w.quantity) THEN 'COMPLETE'
             ELSE 'OVER'
        END,
        w.mode,
        CASE WHEN w.mode = 'WEIGHT' THEN w.labeled_weight END,
        w.wsum,
        w.boxes
    FROM w;
$function$;
