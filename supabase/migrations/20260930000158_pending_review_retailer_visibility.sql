-- ====================================================================
-- 승인대기(pending_review) 거래처를 공급사가 조회할 수 있도록 RLS 확대
--
-- 157에서 wholesaler_retailers.status에 'pending_review'를 추가했지만,
-- retailers 테이블 SELECT 정책과 list_linked_retailer_phones() RPC는
-- 여전히 status='active'만 허용하고 있었다. 그 결과 "고객 관리" 화면에서
-- 승인대기 손님은 wholesaler_retailers 행(행 자체는 보임)은 뜨지만 연결된
-- retailers 조인이 항상 비어 "이름 미등록 고객(소매)"로만 표시되고
-- 연락처도 나오지 않아, 승인 검토 화면(customer-table.tsx의 "아는 손님이
-- 맞는지 확인한 뒤 승인해주세요")이 사실상 무용지물이었다 — 누구를
-- 승인하는지 알 방법이 없었다.
--
-- 두 곳 모두 status 조건에 'pending_review'를 추가한다. active와
-- pending_review 둘 다 "이 공급사와 이미 관계가 생긴 손님"이라는 점은
-- 같고(blocked만 관계가 끊어진 상태), 카탈로그 열람(맞춤단가·발주 가능
-- 여부)은 이 정책과 무관하게 lib/shop/catalog.ts의 별도 게이트가 막는다
-- — 여기서 넓히는 건 "공급사가 자기 거래처 목록에서 이름/연락처를 보는
-- 권한"뿐이다.
-- ====================================================================

DROP POLICY IF EXISTS "Retailers viewable by self, linked wholesaler org staff, or admin" ON public.retailers;
CREATE POLICY "Retailers viewable by self, linked wholesaler org staff, or admin" ON public.retailers
    FOR SELECT USING (
        profile_id = auth.uid()
        OR public.get_current_role() = 'super_admin'
        OR id IN (
            SELECT retailer_id FROM public.wholesaler_retailers
            WHERE status IN ('active', 'pending_review')
              AND (
                  wholesaler_id = public.get_current_wholesaler_id()
                  OR public.is_org_staff_of_wholesaler(wholesaler_id)
              )
        )
    );

CREATE OR REPLACE FUNCTION public.list_linked_retailer_phones(p_wholesaler_id UUID)
RETURNS TABLE(retailer_id UUID, phone TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT r.id, p.phone
      FROM public.retailers r
      JOIN public.profiles p ON p.id = r.profile_id
      JOIN public.wholesaler_retailers wr ON wr.retailer_id = r.id
     WHERE wr.wholesaler_id = p_wholesaler_id
       AND wr.status IN ('active', 'pending_review')
       AND (
            EXISTS (
                SELECT 1 FROM public.wholesalers w
                 WHERE w.id = p_wholesaler_id AND w.profile_id = auth.uid()
            )
            OR public.is_org_staff_of_wholesaler(p_wholesaler_id)
            OR public.get_current_role() = 'super_admin'
       );
$$;

REVOKE ALL ON FUNCTION public.list_linked_retailer_phones(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_linked_retailer_phones(UUID) TO authenticated;
