-- 명세서 ↔ 실물 박스의 로트·개체 번호 층이 다를 때 잇는 다리 (2026-09-25, 사장님 "진행")
--
-- 명세서에는 묶음번호(L…, 돼지 12마리 한 묶음)가 적혀 있는데 박스에는 그 안의 한 마리 개체번호
-- (12자리)가 찍혀 오는 경우, 그리고 그 반대. 지금까지는 번호 문자열이 같아야만 명세서 줄을 찾았다.
--
-- 명세서 저장 시 사전조회가 묶음번호를 정부에 조회하면서 구성 개체번호까지 받아 master_livestock.raw_payload에
-- 그대로 두고 있으므로(개체마다 pigNo/cattleNo가 붙은 <item> 반복 구조), 그 목록으로 잇는다.
--
-- 잠긴 결정은 그대로다: 재고 단위는 여전히 로트(개체별로 쪼개지 않음). 여기서 하는 건 "이 박스가 명세서의
-- 어느 줄인가"를 찾는 조회용 연결만이다. 판정 원칙도 그대로 — 서로 다른 상품·부위·등급이 걸리면 NULL(되묻는다).
--
-- 함수 본문은 로컬 DB pg_get_functiondef(115까지 적용된 판)를 기준으로, 세 조회 함수의 줄 선택 조건을
-- 공용 헬퍼 document_lines_matching_trace()로 뽑아냈다.

-- 묶음번호의 구성 개체번호 목록. 캐시에 없거나 로트가 아니면 빈 배열.
CREATE OR REPLACE FUNCTION public.lot_member_trace_nos(p_lot_no text)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT COALESCE(
        (
            SELECT array_agg(DISTINCT upper(btrim(v #>> '{}')))
            FROM public.master_livestock m,
                 LATERAL (
                     SELECT jsonb_path_query(m.raw_payload, 'lax $.**.pigNo') AS v
                     UNION ALL
                     SELECT jsonb_path_query(m.raw_payload, 'lax $.**.cattleNo')
                 ) members
            WHERE m.trace_no = upper(btrim(p_lot_no))
              AND m.trace_kind = 'group'
              AND btrim(v #>> '{}') <> ''
        ),
        '{}'::text[]
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.lot_member_trace_nos(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.lot_member_trace_nos(text) IS
    '묶음(로트)번호의 구성 개체번호(pigNo/cattleNo). master_livestock.raw_payload에서 되읽는다. 내부용.';


-- 이 업체의 살아 있는 명세서 줄 중 p_trace_no(박스에서 찍힌 번호)에 해당하는 줄.
--   같음        : trace_no 또는 lot_no가 그 번호
--   줄이 로트   : 줄의 번호(trace_no 또는 lot_no)가 로트이고 찍힌 개체번호가 그 구성원
--   찍힌 게 로트: 찍힌 번호가 로트이고 줄의 개체번호(trace_no)가 그 구성원
CREATE OR REPLACE FUNCTION public.document_lines_matching_trace(p_wholesaler_id uuid, p_trace_no text)
 RETURNS SETOF public.inbound_document_lines
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_trace_no      TEXT;
    v_scan_members  TEXT[];
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' OR p_wholesaler_id IS NULL THEN
        RETURN;
    END IF;

    v_trace_no := upper(btrim(p_trace_no));
    -- 찍힌 번호가 로트면 구성원을 한 번만 읽는다(줄마다 다시 읽지 않게).
    v_scan_members := public.lot_member_trace_nos(v_trace_no);

    RETURN QUERY
    SELECT l.*
    FROM public.inbound_document_lines l
    JOIN public.inbound_documents d ON d.id = l.document_id
    WHERE d.wholesaler_id = p_wholesaler_id
      AND d.status <> 'DISCARDED'
      AND (
            upper(l.trace_no) = v_trace_no
         OR upper(l.lot_no)   = v_trace_no
         OR upper(l.trace_no) = ANY (v_scan_members)
         -- 줄의 번호가 로트일 때만 구성원을 읽는다 — 형식으로 먼저 걸러 개체번호 줄에서는 캐시를 안 뒤진다.
         OR (l.trace_no ~ '^[Ll]\d{14}$|^\d{15}$' AND v_trace_no = ANY (public.lot_member_trace_nos(l.trace_no)))
         OR (l.lot_no   ~ '^[Ll]\d{14}$|^\d{15}$' AND v_trace_no = ANY (public.lot_member_trace_nos(l.lot_no)))
      );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.document_lines_matching_trace(uuid, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.document_lines_matching_trace(uuid, text) IS
    '박스 번호에 해당하는 명세서 줄(같은 번호 + 로트↔개체 구성원 관계). 취소 서류 제외. 내부용 — 호출자가 업체 접근 권한을 확인한다.';


CREATE OR REPLACE FUNCTION public.lookup_product_by_document_trace(p_trace_no text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

    SELECT count(DISTINCT l.product_id), min(l.product_id::text)::uuid
      INTO v_distinct, v_product_id
    FROM public.document_lines_matching_trace(v_wholesaler_id, p_trace_no) l
    JOIN public.products p ON p.id = l.product_id
    WHERE l.product_id IS NOT NULL
      AND p.wholesaler_id = v_wholesaler_id
      -- 보관해 치운 상품에는 재고를 다시 붙이지 않는다.
      AND p.archived_at IS NULL;

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    RETURN v_product_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.lookup_document_part_name(p_wholesaler_id uuid, p_trace_no text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_distinct INT;
    v_part     TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN NULL;
    END IF;

    SELECT count(DISTINCT btrim(l.part_name)), min(btrim(l.part_name))
      INTO v_distinct, v_part
    FROM public.document_lines_matching_trace(p_wholesaler_id, p_trace_no) l
    WHERE l.part_name IS NOT NULL
      AND btrim(l.part_name) <> '';

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    RETURN v_part;
END;
$function$;


CREATE OR REPLACE FUNCTION public.lookup_document_grade(p_wholesaler_id uuid, p_trace_no text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_distinct INT;
    v_grade    TEXT;
BEGIN
    IF p_trace_no IS NULL OR btrim(p_trace_no) = '' THEN
        RETURN NULL;
    END IF;

    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN NULL;
    END IF;

    SELECT count(DISTINCT btrim(l.grade)), min(btrim(l.grade))
      INTO v_distinct, v_grade
    FROM public.document_lines_matching_trace(p_wholesaler_id, p_trace_no) l
    WHERE l.grade IS NOT NULL
      AND btrim(l.grade) <> '';

    IF v_distinct <> 1 THEN
        RETURN NULL;
    END IF;

    RETURN v_grade;
END;
$function$;


-- 스캔 화면 "명세서 대기 품목": PENDING 명세서 줄 중 아직 어떤 박스와도 안 만난 줄.
-- 같은 번호뿐 아니라 로트↔개체 관계로도 "만났다"고 본다. 수량은 모른다(번호 기준) — B단계 과제.
CREATE OR REPLACE FUNCTION public.list_awaiting_document_line_ids(p_wholesaler_id uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH lines AS (
        SELECT l.id, upper(l.trace_no) AS t, upper(l.lot_no) AS lo
        FROM public.inbound_document_lines l
        JOIN public.inbound_documents d ON d.id = l.document_id
        WHERE d.wholesaler_id = p_wholesaler_id
          AND d.status = 'PENDING'
          AND (l.trace_no IS NOT NULL OR l.lot_no IS NOT NULL)
    ),
    -- 줄에 적힌 로트의 구성원(줄 수만큼만 읽는다)
    line_members AS (
        SELECT id, unnest(public.lot_member_trace_nos(t) || public.lot_member_trace_nos(lo)) AS m
        FROM lines
    ),
    -- 로트 번호로 찍힌 박스들의 구성원(로트 형식인 스캔만)
    scan_lots AS (
        SELECT DISTINCT upper(s.trace_no) AS t, public.lot_member_trace_nos(s.trace_no) AS ms
        FROM public.inbound_scans s
        WHERE s.wholesaler_id = p_wholesaler_id
          AND s.trace_no ~ '^[Ll]\d{14}$|^\d{15}$'
    )
    SELECT l.id
    FROM lines l
    WHERE NOT EXISTS (
            SELECT 1 FROM public.inbound_scans s
            WHERE s.wholesaler_id = p_wholesaler_id
              AND upper(s.trace_no) IN (l.t, l.lo)
          )
      AND NOT EXISTS (
            SELECT 1
            FROM line_members lm
            JOIN public.inbound_scans s ON upper(s.trace_no) = lm.m
            WHERE lm.id = l.id
              AND s.wholesaler_id = p_wholesaler_id
          )
      AND NOT EXISTS (
            SELECT 1 FROM scan_lots sl WHERE l.t = ANY (sl.ms)
          );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.list_awaiting_document_line_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_awaiting_document_line_ids(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_awaiting_document_line_ids(uuid) IS
    '아직 박스와 안 만난 PENDING 명세서 줄. 같은 번호 + 로트↔개체 구성원 관계로 판정. 수량은 보지 않는다.';


-- 스캔 화면 근거 대조: 찍힌 번호들마다 해당하는 명세서 줄(로트↔개체 포함). 화면은 번호당 첫 줄만 쓴다.
CREATE OR REPLACE FUNCTION public.match_document_lines_for_traces(p_wholesaler_id uuid, p_trace_nos text[])
 RETURNS TABLE (
     scanned_trace_no text,
     trace_no         text,
     lot_no           text,
     item_name        text,
     grade            text,
     origin           text,
     unit_price       numeric,
     labeled_weight   numeric,
     supplier_name    text,
     line_no          integer
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT t.scanned, l.trace_no, l.lot_no, l.item_name, l.grade, l.origin, l.unit_price, l.labeled_weight,
           d.supplier_name, l.line_no
    FROM unnest(COALESCE(p_trace_nos, '{}'::text[])) AS t(scanned)
    CROSS JOIN LATERAL public.document_lines_matching_trace(p_wholesaler_id, t.scanned) l
    JOIN public.inbound_documents d ON d.id = l.document_id
    ORDER BY t.scanned, d.created_at, l.line_no;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.match_document_lines_for_traces(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_document_lines_for_traces(uuid, text[]) TO authenticated;

COMMENT ON FUNCTION public.match_document_lines_for_traces(uuid, text[]) IS
    '찍힌 번호들에 해당하는 명세서 줄(같은 번호 + 로트↔개체). 취소 서류 제외. 스캔 화면 근거 대조용.';
