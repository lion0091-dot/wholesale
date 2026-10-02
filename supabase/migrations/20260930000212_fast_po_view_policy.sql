-- 전표·전표 줄 "조회" 정책을 빠르게 (2026-10-02)
--
-- 전표 화면 조회(60건 × 300줄 = 18,000줄)가 줄마다 can_access_wholesaler()를 불러, 대표 0.8초·직원 3.9초가 걸렸다
-- (정책을 모두 끄면 5ms — scripts의 EXPLAIN 측정). 함수는 행의 업체 id를 받는 보안 함수라 줄마다 다시 돈다.
--
-- 해결: "내가 접근할 수 있는 업체 id 목록"을 쿼리당 한 번만 계산하는 앞 조건을 붙인다(상관 없는 서브쿼리 → 한 번 계산해 해시).
--   · 기존 검사(can_access_wholesaler)는 OR로 그대로 남겨 둔다 — 앞 조건이 못 잡는 경우(슈퍼관리자 등)는 예전과 똑같이 판정한다.
--   · 앞 조건이 허용하는 업체는 기존 검사도 허용하는 업체의 부분집합이다(대표 본인 / 내가 소속된 조직의 업체).
--     그래서 이 정책은 예전과 접근 범위가 같고 더 넓어지지 않는다 — scripts/db-test-po-view-policy.sql이 증명한다.
--   · 익명(anon)에게는 이 정책을 적용하지 않는다(TO authenticated) — 예전에도 익명은 아무 행도 못 봤다.
-- 다른 표(상품·입고 박스 등)에도 같은 방식을 넓힐 수 있으나 보안 정책 전반을 건드리는 일이라 이번에는 전표 2표만 한다.

CREATE OR REPLACE FUNCTION public.my_accessible_wholesaler_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT w.id FROM public.wholesalers w WHERE w.profile_id = auth.uid()
    UNION
    SELECT o.wholesaler_id
    FROM public.organization_staff s
    JOIN public.organizations o ON o.id = s.organization_id
    WHERE s.user_id = auth.uid() AND o.wholesaler_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.my_accessible_wholesaler_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_accessible_wholesaler_ids() TO authenticated, service_role;

DROP POLICY IF EXISTS "Purchase orders viewable by supplier staff" ON public.purchase_orders;
CREATE POLICY "Purchase orders viewable by supplier staff" ON public.purchase_orders
    FOR SELECT TO authenticated
    USING (
        wholesaler_id IN (SELECT public.my_accessible_wholesaler_ids())
        OR public.can_access_wholesaler(wholesaler_id)
    );

DROP POLICY IF EXISTS "Purchase order lines viewable by supplier staff" ON public.purchase_order_lines;
CREATE POLICY "Purchase order lines viewable by supplier staff" ON public.purchase_order_lines
    FOR SELECT TO authenticated
    USING (
        wholesaler_id IN (SELECT public.my_accessible_wholesaler_ids())
        OR public.can_access_wholesaler(wholesaler_id)
    );
