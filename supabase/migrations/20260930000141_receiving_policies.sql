-- 입고 수용 기준 설정 (사장님 확정 원칙, 2026-09-27): 물건을 "받아도 되는가"와 "어느 발주서에 붙이나"의 기준은 코드에 고정하지 않고 도매업체가 정한다.
--
-- 업체당 한 행. 행이 없으면 기본값으로 본다(TS lib/receiving-policy/policy.ts의 DEFAULT_RECEIVING_POLICY와 같은 값 — 바꾸면 양쪽을 같이 고칠 것).
--   over_tolerance_mode/value : 그 거래처 열린 발주 합계보다 얼마까지 더 받아도 되나 — 비율(PERCENT) 또는 킬로그램(KG) 중 하나(기본 0 = 발주 이상은 받지 않음)
--   unlisted_item_policy      : 발주서에 없는 물건 — 받지 않음(REJECT) / 받고 사무실이 확인(HOLD)
--   line_assignment           : 후보 발주서가 여럿일 때 — 사무실이 고름(OFFICE) / 오래된 발주서부터 자동(OLDEST_FIRST). 후보가 하나면 항상 자동.
-- 이 표는 값을 저장만 한다. 입고 때 실제로 판정하는 로직은 입고 연결 단계에서 이 값을 읽는다.
-- 읽기는 업체 직원 전체, 쓰기는 owner·manager(발주서와 같은 기준).

CREATE TABLE IF NOT EXISTS public.receiving_policies (
    wholesaler_id        UUID PRIMARY KEY REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    over_tolerance_mode  TEXT NOT NULL DEFAULT 'PERCENT' CHECK (over_tolerance_mode IN ('PERCENT', 'KG')),
    over_tolerance_value NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (over_tolerance_value >= 0),
    unlisted_item_policy TEXT NOT NULL DEFAULT 'REJECT' CHECK (unlisted_item_policy IN ('REJECT', 'HOLD')),
    line_assignment      TEXT NOT NULL DEFAULT 'OFFICE' CHECK (line_assignment IN ('OFFICE', 'OLDEST_FIRST')),
    updated_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT receiving_policies_percent_range CHECK (over_tolerance_mode <> 'PERCENT' OR over_tolerance_value <= 100)
);

DROP TRIGGER IF EXISTS trg_receiving_policies_updated_at ON public.receiving_policies;
CREATE TRIGGER trg_receiving_policies_updated_at
    BEFORE UPDATE ON public.receiving_policies
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.receiving_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Receiving policy viewable by supplier staff" ON public.receiving_policies;
CREATE POLICY "Receiving policy viewable by supplier staff" ON public.receiving_policies
    FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

DROP POLICY IF EXISTS "Receiving policy managed by owner and manager" ON public.receiving_policies;
CREATE POLICY "Receiving policy managed by owner and manager" ON public.receiving_policies
    FOR ALL USING (public.can_manage_wholesaler(wholesaler_id))
    WITH CHECK (public.can_manage_wholesaler(wholesaler_id));

COMMENT ON TABLE public.receiving_policies IS '업체별 입고 수용 기준 — 초과 허용 오차, 발주서에 없는 물건 처리, 발주서 배정 방식. 행이 없으면 기본값. 판정은 입고 연결 단계에서 읽는다.';
