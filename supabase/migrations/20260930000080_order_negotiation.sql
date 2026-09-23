-- 장바구니 네고 — 고객이 희망 단가를 적어 보내고 공급사가 보고 정한다 (32단계)
--
-- 축산물 도매는 전화로 가격을 맞추는 일이 흔한데, 그러면 "얼마에 하기로 했지"가
-- 아무 데도 안 남아 나중에 분쟁이 난다. 희망가를 주문에 붙여 보내면 **숫자가
-- 기록으로 남는다.** 실제 흥정을 전화로 하더라도 그 자체로 값어치가 있다.
--
-- 주문 상태는 늘리지 않는다. 협상 왕복을 상태로 만들면 "지금 누가 답할 차례인가"를
-- 계속 관리해야 하고, 현실의 흥정은 어차피 전화로 끝난다. 여기서는 **고객의 희망가와
-- 공급사가 최종 확정한 단가가 나란히 남는 것**까지만 한다.
--
-- 이미 있는 거래처별 맞춤가격(custom_prices)과 다르다 — 그건 공급사가 미리 정해두는
-- 값이고, 이건 고객이 이번 주문에 한해 제안하는 값이다.

ALTER TABLE public.order_items
    ADD COLUMN IF NOT EXISTS requested_unit_price NUMERIC(12, 2)
        CHECK (requested_unit_price IS NULL OR requested_unit_price >= 0);

COMMENT ON COLUMN public.order_items.requested_unit_price IS
    '고객이 제시한 희망 단가. unit_price(실제 적용가)와 다르면 공급사가 조정한 것이다.';

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS negotiation_note TEXT;

COMMENT ON COLUMN public.orders.negotiation_note IS
    '고객이 주문할 때 남긴 가격 관련 요청. 전화로 맞추더라도 근거가 남게 한다.';

-- 네고 켜고 끄기는 공급사 권한이다 (사장님 확정).
-- 흥정을 받고 싶지 않은 공급사도 있고, 미니샵에 가격 제안 칸이 떠 있는 것만으로
-- 매번 깎아달라는 요구가 들어온다. **기본값은 꺼짐** — 켜는 건 공급사가 정한다.
ALTER TABLE public.wholesalers
    ADD COLUMN IF NOT EXISTS allow_price_negotiation BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.wholesalers.allow_price_negotiation IS
    '미니샵 장바구니에 희망가 제안 칸을 띄울지. 공급사가 켜고 끈다. 기본 꺼짐.';
