-- ====================================================================
-- wholesaler_retailers 누락된 RLS 정책 추가 (심각한 사전 버그 수정)
--
-- 문제:
--   public.wholesaler_retailers는 RLS가 켜져 있지만(20260909000000) 정책이
--   단 하나도 없었다. RLS가 켜진 테이블에 정책이 0개면 Postgres 기본 동작은
--   전원 차단이다. GRANT SELECT(20260913000000)는 테이블 권한일 뿐 RLS와
--   무관해서 이 차단을 못 풀어준다.
--
--   wholesalers/retailers/products/orders 정책의 "연결된 거래처면 보임" 조건은
--   모두 wholesaler_retailers를 서브쿼리로 참조하는데, 이 서브쿼리 자체가
--   authenticated 롤(실제 바이어/공급사 세션)의 RLS를 그대로 받는다 —
--   SECURITY DEFINER로 감싸지 않은 인라인 서브쿼리라 우회가 안 된다.
--   그 결과 정책이 0개인 동안 이 조건은 항상 거짓이었다.
--
-- 영향받은 것으로 확인된 경로:
--   - loadShopCatalog()가 세션 클라이언트로 wholesalers를 shop_token으로 직접
--     조회 → 연결된 바이어도 이 SELECT가 항상 실패 → status!=='active'로 오인해
--     데모 카탈로그로 폴백(실제 카탈로그/단가가 절대 안 뜸)
--   - submitOrderAction()의 orders INSERT — "Orders insertable by linked
--     retailer" 정책도 같은 서브쿼리라 실제로는 절대 통과 못 함(다만 위 버그로
--     항상 데모 카탈로그를 보므로 buyer가 null이라 이 코드 경로 자체가 실행되지
--     않아 에러로 드러나지 않았다)
--   - app/dashboard/customers/page.tsx — 공급사 본인이 자기 거래처 목록을
--     조회하는 화면도 같은 이유로 항상 빈 목록
--
-- 수정:
--   다른 테이블(custom_prices, orders)과 동일한 패턴으로 SELECT 정책을 추가한다.
--   현재 앱 코드에 wholesaler_retailers를 세션 클라이언트로 직접 INSERT/UPDATE하는
--   경로는 없다(claim_shop_access 등은 SECURITY DEFINER라 테이블 소유자 권한으로
--   RLS를 우회) — 그래서 SELECT 정책만 추가한다.
-- ====================================================================

CREATE POLICY "Wholesaler retailers viewable by participants or admin" ON public.wholesaler_retailers
    FOR SELECT USING (
        wholesaler_id = public.get_current_wholesaler_id()
        OR retailer_id = public.get_current_retailer_id()
        OR public.get_current_role() = 'super_admin'
    );
