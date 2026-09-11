-- ====================================================================
-- PHASE 5 / Task 5.1: Organizations (공급사 조직) & Organization Staff (직원 RBAC)
-- ====================================================================
-- 목적: 단일 도매업자 계정 구조를 "조직 + 다중 직원" 구조로 확장한다.
--       기존 Phase 1 스키마의 public.wholesalers 는 유지하고, organizations 와
--       1:1로 연결(wholesaler_id)하여 점진적으로 이관 가능하도록 설계한다.
-- 보안: 모든 정책은 auth.uid() 기준. organization_staff 를 직접 조회하는
--       정책은 무한 재귀를 유발하므로 SECURITY DEFINER 헬퍼 함수를 경유한다.
-- ====================================================================

-- 1. 직원 역할 ENUM
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_role') THEN
        CREATE TYPE public.organization_role AS ENUM ('owner', 'manager', 'staff');
    END IF;
END $$;

-- 2. ORGANIZATIONS (공급사 조직)
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID UNIQUE REFERENCES public.wholesalers(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    business_number TEXT NOT NULL UNIQUE,
    representative_name TEXT,
    subscription_tier TEXT NOT NULL DEFAULT 'pro'
        CHECK (subscription_tier IN ('lite', 'pro', 'enterprise')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. ORGANIZATION_STAFF (조직 소속 직원 / auth.users 직접 참조)
CREATE TABLE IF NOT EXISTS public.organization_staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role public.organization_role NOT NULL DEFAULT 'staff',
    invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id)
);

-- 한 사용자는 하나의 공급사 조직에만 소속될 수 있다 (경쟁사 교차 접근 차단).
CREATE UNIQUE INDEX IF NOT EXISTS uq_organization_staff_user
    ON public.organization_staff(user_id);

CREATE INDEX IF NOT EXISTS idx_organization_staff_org_role
    ON public.organization_staff(organization_id, role);
CREATE INDEX IF NOT EXISTS idx_organizations_wholesaler
    ON public.organizations(wholesaler_id);

-- ====================================================================
-- updated_at 자동 갱신 트리거
-- ====================================================================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON public.organizations;
CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_organization_staff_updated_at ON public.organization_staff;
CREATE TRIGGER trg_organization_staff_updated_at
    BEFORE UPDATE ON public.organization_staff
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ====================================================================
-- RLS 보안 헬퍼 함수 (SECURITY DEFINER: 정책 내 재귀 방지)
-- ====================================================================

-- 현재 로그인 사용자가 소속된 조직 ID
CREATE OR REPLACE FUNCTION public.get_current_organization_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT organization_id FROM public.organization_staff WHERE user_id = auth.uid();
$$;

-- 현재 로그인 사용자의 조직 내 역할
CREATE OR REPLACE FUNCTION public.get_current_organization_role()
RETURNS public.organization_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT role FROM public.organization_staff WHERE user_id = auth.uid();
$$;

-- 지정 조직의 구성원 여부
CREATE OR REPLACE FUNCTION public.is_organization_member(p_organization_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.organization_staff
        WHERE organization_id = p_organization_id AND user_id = auth.uid()
    );
$$;

-- 지정 조직에서 요구 역할 보유 여부 (예: ARRAY['owner','manager'])
CREATE OR REPLACE FUNCTION public.has_organization_role(
    p_organization_id UUID,
    p_roles public.organization_role[]
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.organization_staff
        WHERE organization_id = p_organization_id
          AND user_id = auth.uid()
          AND role = ANY(p_roles)
    );
$$;

-- 조직에 직원이 한 명도 없는 상태 (최초 owner 등록 부트스트랩 허용용)
CREATE OR REPLACE FUNCTION public.organization_has_no_staff(p_organization_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM public.organization_staff WHERE organization_id = p_organization_id
    );
$$;

-- ====================================================================
-- 마지막 owner 보호 트리거 (조직이 소유자 없이 남는 것을 차단)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.guard_last_organization_owner()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_owner_count INT;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role <> 'owner' THEN
        SELECT count(*) INTO v_owner_count
        FROM public.organization_staff
        WHERE organization_id = OLD.organization_id AND role = 'owner';

        IF v_owner_count <= 1 THEN
            RAISE EXCEPTION '조직에는 최소 1명의 owner가 있어야 합니다.';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' AND OLD.role = 'owner' THEN
        SELECT count(*) INTO v_owner_count
        FROM public.organization_staff
        WHERE organization_id = OLD.organization_id AND role = 'owner';

        IF v_owner_count <= 1 THEN
            RAISE EXCEPTION '마지막 owner는 삭제할 수 없습니다.';
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_guard_last_owner ON public.organization_staff;
CREATE TRIGGER trg_guard_last_owner
    BEFORE UPDATE OR DELETE ON public.organization_staff
    FOR EACH ROW EXECUTE FUNCTION public.guard_last_organization_owner();

-- ====================================================================
-- ROW LEVEL SECURITY
-- ====================================================================
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_staff ENABLE ROW LEVEL SECURITY;

-- 1) ORGANIZATIONS
-- 조회: 소속 직원 또는 슈퍼관리자만 (타 공급사 조직 정보 완전 차단)
DROP POLICY IF EXISTS "Organizations viewable by own staff or admin" ON public.organizations;
CREATE POLICY "Organizations viewable by own staff or admin" ON public.organizations
    FOR SELECT USING (
        public.is_organization_member(id)
        OR public.get_current_role() = 'super_admin'
    );

-- 생성: wholesaler(도매) 또는 슈퍼관리자 역할 계정만
DROP POLICY IF EXISTS "Organizations insertable by wholesaler or admin" ON public.organizations;
CREATE POLICY "Organizations insertable by wholesaler or admin" ON public.organizations
    FOR INSERT WITH CHECK (
        public.get_current_role() IN ('wholesaler', 'super_admin')
    );

-- 수정: owner 또는 슈퍼관리자
DROP POLICY IF EXISTS "Organizations updatable by owner or admin" ON public.organizations;
CREATE POLICY "Organizations updatable by owner or admin" ON public.organizations
    FOR UPDATE USING (
        public.has_organization_role(id, ARRAY['owner']::public.organization_role[])
        OR public.get_current_role() = 'super_admin'
    ) WITH CHECK (
        public.has_organization_role(id, ARRAY['owner']::public.organization_role[])
        OR public.get_current_role() = 'super_admin'
    );

-- 삭제: 슈퍼관리자 전용
DROP POLICY IF EXISTS "Organizations deletable by admin only" ON public.organizations;
CREATE POLICY "Organizations deletable by admin only" ON public.organizations
    FOR DELETE USING (public.get_current_role() = 'super_admin');

-- 2) ORGANIZATION_STAFF
-- 조회: 같은 조직 구성원 또는 슈퍼관리자 (직원 명단 외부 노출 차단)
DROP POLICY IF EXISTS "Staff viewable by same organization or admin" ON public.organization_staff;
CREATE POLICY "Staff viewable by same organization or admin" ON public.organization_staff
    FOR SELECT USING (
        user_id = auth.uid()
        OR public.is_organization_member(organization_id)
        OR public.get_current_role() = 'super_admin'
    );

-- 추가: owner/manager, 슈퍼관리자, 또는 직원이 없는 조직에 본인을 owner로 등록(부트스트랩)
DROP POLICY IF EXISTS "Staff insertable by owner manager or bootstrap" ON public.organization_staff;
CREATE POLICY "Staff insertable by owner manager or bootstrap" ON public.organization_staff
    FOR INSERT WITH CHECK (
        public.has_organization_role(organization_id, ARRAY['owner', 'manager']::public.organization_role[])
        OR public.get_current_role() = 'super_admin'
        OR (
            user_id = auth.uid()
            AND role = 'owner'
            AND public.organization_has_no_staff(organization_id)
        )
    );

-- 수정: owner 또는 슈퍼관리자 (역할 승격/강등은 owner 권한)
DROP POLICY IF EXISTS "Staff updatable by owner or admin" ON public.organization_staff;
CREATE POLICY "Staff updatable by owner or admin" ON public.organization_staff
    FOR UPDATE USING (
        public.has_organization_role(organization_id, ARRAY['owner']::public.organization_role[])
        OR public.get_current_role() = 'super_admin'
    ) WITH CHECK (
        public.has_organization_role(organization_id, ARRAY['owner']::public.organization_role[])
        OR public.get_current_role() = 'super_admin'
    );

-- 삭제: owner/슈퍼관리자 또는 본인 자진 탈퇴 (마지막 owner는 트리거가 차단)
DROP POLICY IF EXISTS "Staff deletable by owner admin or self" ON public.organization_staff;
CREATE POLICY "Staff deletable by owner admin or self" ON public.organization_staff
    FOR DELETE USING (
        public.has_organization_role(organization_id, ARRAY['owner']::public.organization_role[])
        OR public.get_current_role() = 'super_admin'
        OR user_id = auth.uid()
    );

-- ====================================================================
-- 권한 부여 (RLS가 실제 행 단위 접근을 통제)
-- ====================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_staff TO authenticated;
