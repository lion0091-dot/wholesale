-- 알림을 켠 기기 목록 (2026-10-03) — 설정 > "공급사 주문 알림 방식"과 대시보드 경고용. 조회 전용, 새 표 없음.
--
-- push_subscriptions(189)의 RLS는 "내 행만 보기"라 대표가 직원 기기를 못 본다. 그래서 대표·매니저만 부를 수 있는
-- SECURITY DEFINER 함수로 같은 업체의 기기 목록을 준다. 푸시 주소(endpoint)·키(p256dh, auth)는 내려주지 않는다
-- — 보여 주는 것은 "누구의 어떤 기기가 언제 마지막으로 알림을 받았나"뿐이다.

DROP FUNCTION IF EXISTS public.list_push_devices();

CREATE FUNCTION public.list_push_devices()
RETURNS TABLE (
    device_id     uuid,
    user_name     text,
    user_agent    text,
    created_at    timestamptz,
    last_used_at  timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
    v_wid uuid := public.resolve_current_wholesaler_id();
BEGIN
    IF v_wid IS NULL OR NOT public.can_manage_wholesaler(v_wid) THEN
        RAISE EXCEPTION 'NOT_MANAGER';
    END IF;

    RETURN QUERY
    SELECT s.id, COALESCE(p.name, '이름 없음')::text, s.user_agent::text, s.created_at, s.last_used_at
    FROM public.push_subscriptions s
    LEFT JOIN public.profiles p ON p.id = s.user_id
    WHERE s.wholesaler_id = v_wid
    ORDER BY COALESCE(s.last_used_at, s.created_at) DESC, s.id
    LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.list_push_devices() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_push_devices() TO authenticated, service_role;
