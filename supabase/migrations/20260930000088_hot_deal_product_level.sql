-- 핫딜을 "거래처별 매핑"에서 "상품 자체 속성(전체 공개)"으로 재설계
-- (2026-09-24, 사장님 확정).
--
-- 배경: 지금까지 핫딜은 custom_prices(retailer_id, product_id, kind='hot_deal')
-- 매핑이라 "이 거래처 한 곳에게만" 보이는 개별 우대가였다. 그런데 핫딜의 실제
-- 목적(재고 처분)에는 안 맞는다 — 같은 물건을 누구는 정가에, 누구는 할인가에
-- 사가는 불공평한 결과가 나고, 새로 들어온 거래처는 핫딜을 아예 못 본다.
--
-- 잠긴 설계 결정:
--   1. 핫딜은 이제 상품(products) 단위 속성이다. 켜두면 로그인 안 한 손님을
--      포함해 그 상품을 보는 모든 사람에게 할인가가 보인다.
--   2. 맞춤단가(custom_prices)는 원래 목적(거래처별 개별 우대)만 남긴다.
--      핫딜과 섞어 쓰던 kind 구분은 필요 없어져 제거한다 — 라이브 데이터에
--      kind='hot_deal' 행이 0건임을 확인하고 진행(데이터 이관 불필요).

-- --------------------------------------------------------------------
-- 1. products에 핫딜 컬럼 추가
-- --------------------------------------------------------------------
ALTER TABLE public.products
    ADD COLUMN IF NOT EXISTS hot_deal_price  NUMERIC(12, 2) CHECK (hot_deal_price IS NULL OR hot_deal_price >= 0),
    ADD COLUMN IF NOT EXISTS hot_deal_active BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.products.hot_deal_price IS
    '핫딜 할인가. hot_deal_active가 꺼져 있으면 값이 남아 있어도 적용 안 됨(재입고 시 다시 켜기 편하도록).';
COMMENT ON COLUMN public.products.hot_deal_active IS
    '켜져 있으면 이 상품을 보는 모든 고객(비로그인 포함)에게 hot_deal_price가 기준가 대신 보인다.';


-- --------------------------------------------------------------------
-- 2. custom_prices에서 kind(hot_deal) 제거 — 맞춤단가 전용으로 되돌린다.
-- --------------------------------------------------------------------
DELETE FROM public.custom_prices WHERE kind = 'hot_deal';

ALTER TABLE public.custom_prices
    DROP CONSTRAINT IF EXISTS custom_prices_retailer_id_product_id_kind_key;

ALTER TABLE public.custom_prices
    ADD CONSTRAINT custom_prices_retailer_id_product_id_key UNIQUE (retailer_id, product_id);

ALTER TABLE public.custom_prices DROP COLUMN IF EXISTS kind;


-- --------------------------------------------------------------------
-- 3. 상품별 남은 재고를 입고 박스 단위(오래된 순)로 보여준다 — 핫딜 켤지
--    말지 판단할 때 "얼마나 오래된 재고가 얼마나 남았는지" 보는 용도.
--    기존 get_expiring_boxes(전체 상품 대상, 임박한 것만)와 달리 이건 상품
--    하나를 지정해 전체 잔량을 다 보여준다.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_product_stock_breakdown(p_product_id UUID)
RETURNS TABLE (
    box_id           UUID,
    trace_no         TEXT,
    remaining_weight NUMERIC,
    unit             TEXT,
    scanned_at       TIMESTAMPTZ,
    best_before      DATE
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        s.id,
        s.trace_no,
        s.remaining_weight,
        s.unit,
        s.created_at,
        s.best_before
    FROM public.inbound_scans s
    JOIN public.products p ON p.id = s.product_id
    WHERE s.product_id = p_product_id
      AND s.status = 'NORMAL'
      AND s.remaining_weight > 0
      AND (
            public.can_access_wholesaler(p.wholesaler_id)
      )
    ORDER BY s.created_at;
$$;

REVOKE EXECUTE ON FUNCTION public.get_product_stock_breakdown(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_product_stock_breakdown(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_product_stock_breakdown(UUID) IS
    '상품 하나의 남은 재고를 입고 박스 단위(오래된 순)로 전부 보여준다. 핫딜 지정 판단용.';
