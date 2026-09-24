-- 상품 "발주정지" 상태 추가 (2026-09-24, 사장님 확정. 같은 날 전체 상품으로 범위 확장).
--
-- 배경: 재고가 실제로 떨어지면 손님이 계속 주문을 시도할 수 있다. 기존 "품절"
-- (stock_quantity<=0) 표시만으로는 부족한 이유 — 재입고되면 stock_quantity>0이
-- 되는 순간 자동으로 다시 팔리기 시작하는데, 공급사는 재입고돼도 가격/수량을
-- 다시 확인하고 직접 재개하고 싶어한다.
--
-- 잠긴 설계 결정:
--   1. order_stopped는 hot_deal_active 여부와 무관하게 모든 상품에 의미 있는
--      상태다(최초 설계는 핫딜 전용이었으나, 같은 날 "정상매장 상품도 재고 0이면
--      동일하게 자동정지해야 한다"는 결정으로 범위를 넓혔다 — 재고 소진 후
--      재입고 시 판매가를 다시 확인하고 싶은 니즈는 핫딜/일반 구분이 없다).
--      품절 표시(stock_quantity<=0)와는 독립적 — 재고가 남아 있어도 관리자가
--      수동으로 정지할 수 있다.
--   2. 재고가 0이 되면 자동으로 켜진다(recalc_product_stock 훅, 상품 종류 무관).
--      관리자가 수동으로 켤 수도 있다.
--   3. 재입고(재고>0)돼도 자동으로는 안 풀린다 — 반드시 관리자가 상품 수정
--      화면에서 직접 재개해야 한다(이유 불문, 자동/수동 둘 다 동일).
--   4. 핫딜 토글을 끌 때는 예외적으로 자동 해제가 기본값이다("핫딜 오프 = 정상
--      판매 온"이 페어 원칙) — 단 그 시점 재고가 여전히 0이면 풀지 않는다
--      (app/dashboard/products/actions.ts). 핫딜과 무관하게 켜진 발주정지는
--      이 자동해제 대상이 아니다.
--   5. 알림은 지금은 외부 발송 채널(알림톡/SMS)이 없어 대시보드 인앱 배너로만
--      한다 — 별도 알림 테이블 없이 상품 상태를 그대로 조회해서 보여준다.

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS order_stopped        BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS order_stopped_reason  TEXT
        CHECK (order_stopped_reason IS NULL OR order_stopped_reason IN ('out_of_stock', 'manual')),
    ADD COLUMN IF NOT EXISTS order_stopped_at      TIMESTAMPTZ;

COMMENT ON COLUMN public.products.order_stopped IS
    '켜지면 hot_deal_active 여부와 무관하게 고객이 이 상품을 발주할 수 없다(핫딜 상품이면 핫딜 탭에는 계속 보임). 재입고돼도 자동으로 안 풀리고 관리자가 직접 재개해야 한다. 핫딜/일반 상품 공통 상태다.';
COMMENT ON COLUMN public.products.order_stopped_reason IS
    '정지 사유 — out_of_stock(재고 0 자동정지) / manual(관리자 수동정지). 인앱 알림 문구 구분용.';
COMMENT ON COLUMN public.products.order_stopped_at IS
    '정지된 시각. 재개(order_stopped=false) 시 함께 NULL로 되돌린다.';


-- --------------------------------------------------------------------
-- recalc_product_stock() 확장 — 재고가 이번 갱신으로 0 이하가 되고 아직 정지
-- 상태가 아니면 자동으로 발주정지를 켠다. 핫딜/일반 상품 공통(2026-09-24 확장,
-- 최초 설계는 hot_deal_active 상품에만 적용했었다).
-- 기존 호출부(입고/출고/재고조정 전부)는 시그니처가 그대로라 수정 불필요.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalc_product_stock(p_product_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_new_stock NUMERIC;
BEGIN
    SELECT COALESCE(SUM(qty_delta), 0) INTO v_new_stock
    FROM public.stock_ledger
    WHERE product_id = p_product_id;

    UPDATE public.products
    SET stock_quantity = v_new_stock,
        order_stopped = CASE
            WHEN v_new_stock <= 0 AND NOT order_stopped THEN true
            ELSE order_stopped
        END,
        order_stopped_reason = CASE
            WHEN v_new_stock <= 0 AND NOT order_stopped THEN 'out_of_stock'
            ELSE order_stopped_reason
        END,
        order_stopped_at = CASE
            WHEN v_new_stock <= 0 AND NOT order_stopped THEN now()
            ELSE order_stopped_at
        END,
        updated_at = now()
    WHERE id = p_product_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recalc_product_stock(UUID) FROM PUBLIC;
