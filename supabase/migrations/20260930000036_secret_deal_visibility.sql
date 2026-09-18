-- ====================================================================
-- 시크릿 딜 선택적 노출 — 상품별로 특정 거래처(고객)에게만 노출
--
-- 잠긴 설계 결정: 이 테이블에 행이 하나도 없는 시크릿 딜 상품은 기존 동작
-- 그대로 "거래중(active)인 모든 고객"에게 노출된다. 행을 추가한 상품만
-- 화이트리스트로 좁혀져서, 지정된 retailer_id만 볼 수 있게 된다.
-- (lib/shop/catalog.ts의 필터 로직이 이 기본값을 구현한다.)
-- ====================================================================

CREATE TABLE public.secret_deal_visibility (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    retailer_id UUID NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, retailer_id)
);

CREATE INDEX idx_secret_deal_visibility_product ON public.secret_deal_visibility(product_id);
CREATE INDEX idx_secret_deal_visibility_wholesaler ON public.secret_deal_visibility(wholesaler_id);

ALTER TABLE public.secret_deal_visibility ENABLE ROW LEVEL SECURITY;

-- 조회: 소유자 본인 / 조직 직원(전 역할, 상품 조회와 동일 기준) / 지정 대상 고객 본인 / 관리자
CREATE POLICY "Secret deal visibility viewable by owner, org staff, target retailer, or admin"
    ON public.secret_deal_visibility
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR retailer_id = public.get_current_retailer_id()
        OR public.get_current_role() = 'super_admin'
    );

-- 지정 추가: 소유자 본인 또는 조직 owner/manager (상품 관리와 동일 기준)
CREATE POLICY "Secret deal visibility insertable by owner or org manager"
    ON public.secret_deal_visibility
    FOR INSERT WITH CHECK (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[])
    );

-- 지정 해제: 위와 동일 기준
CREATE POLICY "Secret deal visibility deletable by owner or org manager"
    ON public.secret_deal_visibility
    FOR DELETE USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[])
    );

GRANT SELECT, INSERT, DELETE ON public.secret_deal_visibility TO authenticated;
