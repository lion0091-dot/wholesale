-- ====================================================================
-- PHASE 6 / Task 5.3: Custom (VIP) Pricing — 조직 스코프 확장 & RLS
-- ====================================================================
-- 목적: 고객사(식당)별 맞춤 단가를 organization 스코프로 관리한다.
--       Phase 1에서 이미 public.custom_prices(wholesaler_id 기반)가 존재하므로
--       멱등(idempotent)하게 organization_id를 추가하고 정책을 재정의한다.
-- ====================================================================

-- 1. 테이블 (신규 환경용 — 기존 환경에서는 스킵되고 아래 ALTER로 정렬된다)
CREATE TABLE IF NOT EXISTS public.custom_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    wholesaler_id UUID REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    retailer_id UUID NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    custom_price NUMERIC(12, 2) NOT NULL CHECK (custom_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (retailer_id, product_id)
);

-- 2. 기존 테이블 정렬: organization_id 추가 및 wholesaler_id NOT NULL 해제
ALTER TABLE public.custom_prices
    ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.custom_prices
    ALTER COLUMN wholesaler_id DROP NOT NULL;

-- 3. 기존 데이터 백필 (wholesalers <-> organizations 1:1 연결 기준)
UPDATE public.custom_prices cp
SET organization_id = o.id
FROM public.organizations o
WHERE cp.organization_id IS NULL
  AND cp.wholesaler_id IS NOT NULL
  AND o.wholesaler_id = cp.wholesaler_id;

-- 4. 소유자 식별자 중 최소 하나는 반드시 존재해야 한다
ALTER TABLE public.custom_prices
    DROP CONSTRAINT IF EXISTS custom_prices_owner_present;
ALTER TABLE public.custom_prices
    ADD CONSTRAINT custom_prices_owner_present
    CHECK (organization_id IS NOT NULL OR wholesaler_id IS NOT NULL);

-- 5. 인덱스
CREATE INDEX IF NOT EXISTS idx_custom_prices_org_retailer
    ON public.custom_prices(organization_id, retailer_id);
CREATE INDEX IF NOT EXISTS idx_custom_prices_product
    ON public.custom_prices(product_id);

-- 6. updated_at 자동 갱신
DROP TRIGGER IF EXISTS trg_custom_prices_updated_at ON public.custom_prices;
CREATE TRIGGER trg_custom_prices_updated_at
    BEFORE UPDATE ON public.custom_prices
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ====================================================================
-- 7. RLS — VIP 단가는 해당 공급사 조직과 지정된 식당에게만 보인다
-- ====================================================================
ALTER TABLE public.custom_prices ENABLE ROW LEVEL SECURITY;

-- Phase 1의 wholesaler 전용 정책을 조직 인식 정책으로 교체
DROP POLICY IF EXISTS "Custom prices viewable by wholesaler or specific retailer" ON public.custom_prices;
DROP POLICY IF EXISTS "Custom prices manageable by wholesaler" ON public.custom_prices;

-- 조회: 소속 조직 직원(전 역할) / 레거시 도매 본인 / 단가 대상 식당 본인 / 슈퍼관리자
DROP POLICY IF EXISTS "Custom prices viewable by org staff target retailer or admin" ON public.custom_prices;
CREATE POLICY "Custom prices viewable by org staff target retailer or admin" ON public.custom_prices
    FOR SELECT USING (
        (organization_id IS NOT NULL AND organization_id = public.get_current_organization_id())
        OR (wholesaler_id IS NOT NULL AND wholesaler_id = public.get_current_wholesaler_id())
        OR retailer_id = public.get_current_retailer_id()
        OR public.get_current_role() = 'super_admin'
    );

-- 생성: 조직의 owner/manager 또는 레거시 도매 본인
DROP POLICY IF EXISTS "Custom prices insertable by org manager or owner" ON public.custom_prices;
CREATE POLICY "Custom prices insertable by org manager or owner" ON public.custom_prices
    FOR INSERT WITH CHECK (
        (
            organization_id IS NOT NULL
            AND public.has_organization_role(organization_id, ARRAY['owner', 'manager']::public.organization_role[])
        )
        OR (wholesaler_id IS NOT NULL AND wholesaler_id = public.get_current_wholesaler_id())
        OR public.get_current_role() = 'super_admin'
    );

-- 수정: 동일 조건 (USING + WITH CHECK 양쪽 적용으로 소유권 이전 차단)
DROP POLICY IF EXISTS "Custom prices updatable by org manager or owner" ON public.custom_prices;
CREATE POLICY "Custom prices updatable by org manager or owner" ON public.custom_prices
    FOR UPDATE USING (
        (
            organization_id IS NOT NULL
            AND public.has_organization_role(organization_id, ARRAY['owner', 'manager']::public.organization_role[])
        )
        OR (wholesaler_id IS NOT NULL AND wholesaler_id = public.get_current_wholesaler_id())
        OR public.get_current_role() = 'super_admin'
    ) WITH CHECK (
        (
            organization_id IS NOT NULL
            AND public.has_organization_role(organization_id, ARRAY['owner', 'manager']::public.organization_role[])
        )
        OR (wholesaler_id IS NOT NULL AND wholesaler_id = public.get_current_wholesaler_id())
        OR public.get_current_role() = 'super_admin'
    );

-- 삭제: 조직의 owner/manager 또는 레거시 도매 본인
DROP POLICY IF EXISTS "Custom prices deletable by org manager or owner" ON public.custom_prices;
CREATE POLICY "Custom prices deletable by org manager or owner" ON public.custom_prices
    FOR DELETE USING (
        (
            organization_id IS NOT NULL
            AND public.has_organization_role(organization_id, ARRAY['owner', 'manager']::public.organization_role[])
        )
        OR (wholesaler_id IS NOT NULL AND wholesaler_id = public.get_current_wholesaler_id())
        OR public.get_current_role() = 'super_admin'
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_prices TO authenticated;
