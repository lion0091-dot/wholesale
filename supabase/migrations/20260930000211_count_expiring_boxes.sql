-- 알림벨 "소비기한 임박·오래된 박스" 숫자 (2026-10-02)
--
-- "임박·오래됨"의 정의는 get_expiring_boxes 한 곳에만 둔다(소비기한이 있으면 D-3 이내·지난 것, 소비기한이 없으면 도축일이
-- 14일 넘은 것). 벨이 5분마다·화면 이동마다 세므로 목록 대신 개수만 돌려주는 가벼운 함수를 따로 둔다.
-- 정의를 바꾸면 get_expiring_boxes만 고치면 벨 숫자와 목록 화면이 같이 바뀐다.
CREATE OR REPLACE FUNCTION public.count_expiring_boxes(p_days integer DEFAULT 3, p_slaughter_fallback_days integer DEFAULT 14)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT count(*)::integer FROM public.get_expiring_boxes(p_days, p_slaughter_fallback_days);
$$;

REVOKE ALL ON FUNCTION public.count_expiring_boxes(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.count_expiring_boxes(integer, integer) TO authenticated, service_role;
