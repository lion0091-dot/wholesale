-- ====================================================================
-- 판매가가 없는(0원) 상품은 고객에게 노출하지 않는다
--
-- 지금은 is_active만 보고 있어서, 판매가를 아직 안 정한 상품(base_price = 0)이
-- 미니샵에 "0원"으로 그대로 뜬다. 입고는 했지만 값을 안 매긴 상품이 고객 눈에
-- 0원으로 보이면 주문이 들어와버린다.
--
-- 공급사·직원·관리자는 그대로 본다 — 값을 매기려면 목록에 보여야 하기 때문이다.
-- 화면에는 "판매가 미설정 · 고객 비노출" 배지로 이유를 밝힌다.
-- ====================================================================
DROP POLICY IF EXISTS "Products viewable by owner, org staff, linked retailers, or admin" ON public.products;

CREATE POLICY "Products viewable by owner, org staff, priced for retailers, or admin" ON public.products
    FOR SELECT USING (
        public.can_access_wholesaler(wholesaler_id)
        OR (
            is_active = true
            -- 판매가 미설정(0원) 상품은 고객 쪽 조회에서 제외한다.
            AND base_price > 0
            AND wholesaler_id IN (
                SELECT wholesaler_id FROM public.wholesaler_retailers
                WHERE retailer_id = public.get_current_retailer_id() AND status = 'active'
            )
        )
    );
