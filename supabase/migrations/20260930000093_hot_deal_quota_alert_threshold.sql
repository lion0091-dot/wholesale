-- 핫딜 한도 임박 알림 기준을 공급사가 직접 설정할 수 있게 한다 (2026-09-24, 사장님 요청).
--
-- 20260930000091~092에서 판매 한도(hot_deal_quantity_limit) 자체는 상품마다 다르게
-- 잡을 수 있는데, "임박했다"고 볼 기준(남은 수량)을 80%로 하드코딩해두면 상품마다
-- 스케일이 달라(한도 20개 vs 200개) 공급사가 원하는 시점과 안 맞을 수 있다.
-- 남은 수량 기준으로 상품별로 설정 가능하게 한다. 비워두면(NULL) 한도의 20%가
-- 남았을 때를 기본값으로 쓴다(앱 레이어에서 계산, 별도 컬럼 없이 파생).

ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS hot_deal_quota_alert_threshold NUMERIC(10, 2)
        CHECK (hot_deal_quota_alert_threshold IS NULL OR hot_deal_quota_alert_threshold >= 0);

COMMENT ON COLUMN public.products.hot_deal_quota_alert_threshold IS
    '핫딜 한도 임박 알림을 남은 수량 기준으로 언제 띄울지(공급사 설정). NULL이면 한도의 20% 남았을 때 기본 적용.';
