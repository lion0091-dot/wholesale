-- ====================================================================
-- 초대받은 직원(organization_staff) 계정이 실데이터를 못 보던 버그 수정
--
-- 문제: get_current_wholesaler_id()는 "이 업체를 직접 카카오로 가입한 그 계정"
-- (wholesalers.profile_id = auth.uid())만 인식한다. 조직/직원 초대 기능
-- (20260911000000)이 나중에 추가됐지만 이 함수는 그대로였고, wholesalers/
-- wholesaler_retailers/retailers/products/orders 정책이 전부 이 함수에
-- 의존해서 owner 본인 계정 말고는(manager/staff) 백오피스에서 실데이터를
-- 전혀 못 보고(조회) 상품 관리·주문 처리도(쓰기) 못 하는 상태였다.
--
-- 수정: custom_prices(20260911010000), wholesaler_retailers UPDATE
-- (20260930000019)에서 이미 쓴 것과 같은 패턴 — organization_staff를 경유해
-- wholesaler_id를 확인하는 헬퍼를 추가하고, 영향받은 정책에 OR 조건으로 끼워넣는다.
-- ====================================================================

-- 지정 wholesaler_id에 소속된 조직 직원인지 확인 (역할 배열 미지정 시 전 역할 허용)
CREATE OR REPLACE FUNCTION public.is_org_staff_of_wholesaler(
    p_wholesaler_id UUID,
    p_roles public.organization_role[] DEFAULT NULL
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_staff s
        JOIN public.organizations o ON o.id = s.organization_id
        WHERE o.wholesaler_id = p_wholesaler_id
          AND s.user_id = auth.uid()
          AND (p_roles IS NULL OR s.role = ANY(p_roles))
    );
$$;

-- 1) WHOLESALERS — 직원도 소속 업체 정보(상호/주소 등)는 조회 가능해야 한다.
DROP POLICY IF EXISTS "Wholesalers viewable by self, linked retailers, or admin" ON public.wholesalers;
CREATE POLICY "Wholesalers viewable by self, org staff, linked retailers, or admin" ON public.wholesalers
    FOR SELECT USING (
        profile_id = auth.uid()
        OR public.is_org_staff_of_wholesaler(id)
        OR public.get_current_role() = 'super_admin'
        OR id IN (SELECT wholesaler_id FROM public.wholesaler_retailers WHERE retailer_id = public.get_current_retailer_id() AND status = 'active')
    );
-- UPDATE(사업자정보 수정)는 의도적으로 그대로 둔다 — 앱 코드(supplier-auth.ts)도
-- profile_id 기준으로만 수정을 허용하도록 설계돼 있어 owner 전용이 맞다.

-- 2) WHOLESALER_RETAILERS — "고객 관리"/"미수금 정산" 화면이 직원 계정엔 항상 빈 목록이었다.
DROP POLICY IF EXISTS "Wholesaler retailers viewable by participants or admin" ON public.wholesaler_retailers;
CREATE POLICY "Wholesaler retailers viewable by participants, org staff, or admin" ON public.wholesaler_retailers
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR retailer_id = public.get_current_retailer_id()
        OR public.get_current_role() = 'super_admin'
    );

-- 3) RETAILERS — 위와 같은 원인의 보조 경로.
DROP POLICY IF EXISTS "Retailers viewable by self, linked wholesaler, or admin" ON public.retailers;
CREATE POLICY "Retailers viewable by self, linked wholesaler org staff, or admin" ON public.retailers
    FOR SELECT USING (
        profile_id = auth.uid()
        OR public.get_current_role() = 'super_admin'
        OR id IN (
            SELECT retailer_id FROM public.wholesaler_retailers
            WHERE status = 'active'
              AND (
                  wholesaler_id = public.get_current_wholesaler_id()
                  OR public.is_org_staff_of_wholesaler(wholesaler_id)
              )
        )
    );

-- 4) PRODUCTS — 조회는 전 직원, 등록/수정/삭제는 owner/manager만(앱 코드 PRODUCT_ROLES와 동일).
DROP POLICY IF EXISTS "Products viewable by owner, linked retailers, or admin" ON public.products;
CREATE POLICY "Products viewable by owner, org staff, linked retailers, or admin" ON public.products
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR public.get_current_role() = 'super_admin'
        OR (
            is_active = true
            AND wholesaler_id IN (
                SELECT wholesaler_id FROM public.wholesaler_retailers
                WHERE retailer_id = public.get_current_retailer_id() AND status = 'active'
            )
        )
    );

DROP POLICY IF EXISTS "Products manageable by owner wholesaler" ON public.products;
CREATE POLICY "Products manageable by owner or org manager" ON public.products
    FOR ALL USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[])
    )
    WITH CHECK (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id, ARRAY['owner', 'manager']::public.organization_role[])
    );

-- 5) ORDERS — 조회/상태변경(접수확인·배송처리) 전부 앱 코드 ORDER_ROLES(owner/manager/staff)와 맞춘다.
DROP POLICY IF EXISTS "Orders viewable by participating wholesaler or retailer" ON public.orders;
CREATE POLICY "Orders viewable by participating wholesaler, org staff, or retailer" ON public.orders
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR retailer_id = public.get_current_retailer_id()
        OR public.get_current_role() = 'super_admin'
    );

DROP POLICY IF EXISTS "Orders updatable by wholesaler (status) or retailer (cancel)" ON public.orders;
CREATE POLICY "Orders updatable by wholesaler org staff (status) or retailer (cancel)" ON public.orders
    FOR UPDATE USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR public.is_org_staff_of_wholesaler(wholesaler_id)
        OR (retailer_id = public.get_current_retailer_id() AND status = 'pending')
    );

-- order_items는 별도 변경 불필요 — SELECT 정책이 부모 orders 가시성에 그대로
-- 의존(EXISTS)하므로 위 orders SELECT 수정이 자동으로 반영된다.
