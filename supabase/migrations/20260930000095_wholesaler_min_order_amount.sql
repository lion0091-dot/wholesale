-- 최소 주문 금액을 공급사별로 설정 가능하게 한다 (2026-09-24, 사장님 요청).
--
-- 배경: 지금까지 최소 발주 금액(MIN_ORDER_AMOUNT)은 lib/shop/order-policy.ts에
-- 50,000원으로 플랫폼 전체 하드코딩돼 있었다. 공급사마다 품목 단가·물류 비용이
-- 달라 기준이 달라야 한다는 요청으로, 거래명세 영업 화면(맞춤단가 네고 설정과
-- 같은 위치)에서 공급사가 직접 조정할 수 있게 한다.
--
-- 기본값 50000으로 잡아 기존 공급사는 지금 동작 그대로 유지된다(마이그레이션
-- 적용만으로는 아무 화면도 안 바뀜, 공급사가 값을 바꿔야 반영).

ALTER TABLE public.wholesalers
    ADD COLUMN IF NOT EXISTS min_order_amount NUMERIC(12, 2) NOT NULL DEFAULT 50000
        CHECK (min_order_amount >= 0);

COMMENT ON COLUMN public.wholesalers.min_order_amount IS
    '이 공급사 미니샵의 배송 1건당 최소 주문 금액. 공급사가 영업·초대장 화면에서 직접 설정.';
