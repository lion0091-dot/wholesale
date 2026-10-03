-- 알림을 켠 기기 지우기 (2026-10-03) — 설정 > "공급사 주문 알림 방식"의 기기 목록에서 오래 알림이 없는 기기를 정리한다.
--
-- push_subscriptions(189)의 DELETE 정책은 "내 행만"이라 대표가 직원이 쓰던(바꾼 폰 등) 기기를 못 지운다.
-- 대표·매니저만 부를 수 있는 SECURITY DEFINER 함수로 **같은 업체의 기기 한 건**만 지운다. 지워도 그 기기에서 다시 [알림 켜기]를 누르면 돌아온다.
-- 지운 기기가 있었으면 true, 없거나 남의 업체 것이면 false(남의 업체 기기가 있는지는 알려 주지 않는다).

DROP FUNCTION IF EXISTS public.remove_push_device(uuid);

CREATE FUNCTION public.remove_push_device(p_device_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_wid     uuid := public.resolve_current_wholesaler_id();
    v_deleted integer;
BEGIN
    IF v_wid IS NULL OR NOT public.can_manage_wholesaler(v_wid) THEN
        RAISE EXCEPTION 'NOT_MANAGER';
    END IF;

    DELETE FROM public.push_subscriptions WHERE id = p_device_id AND wholesaler_id = v_wid;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN v_deleted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_push_device(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_push_device(uuid) TO authenticated, service_role;
