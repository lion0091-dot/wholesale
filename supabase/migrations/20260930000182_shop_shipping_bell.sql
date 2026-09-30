-- 미니샵 고객 알림벨(배송 시작): 주문이 "배송중"이 된 시각 기록 + 고객별 마지막 확인 시각.
-- 알림 내용은 주문에서 그대로 뽑는다(알림 테이블 없음) — 시각만 있으면 벨이 계산된다.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipped_at timestamptz;

-- 배송중으로 바뀌는 순간에만 찍고, 그 외 경로에서는 값을 바꾸지 못하게 옛 값으로 되돌린다
-- (바이어 세션의 UPDATE가 자기 벨 시각을 조작하는 것도 막는다).
CREATE OR REPLACE FUNCTION public.set_order_shipped_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.shipped_at := CASE WHEN NEW.status = 'shipping' THEN now() ELSE NULL END;
    ELSIF NEW.status = 'shipping' AND OLD.status IS DISTINCT FROM 'shipping' THEN
        NEW.shipped_at := now();
    ELSE
        NEW.shipped_at := OLD.shipped_at;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_order_shipped_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_set_shipped_at ON public.orders;
CREATE TRIGGER trg_orders_set_shipped_at
    BEFORE INSERT OR UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.set_order_shipped_at();

-- 고객(retailer) × 공급사 별 벨 마지막 확인 시각.
CREATE TABLE IF NOT EXISTS public.retailer_bell_reads (
    retailer_id   uuid NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
    wholesaler_id uuid NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    seen_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (retailer_id, wholesaler_id)
);

ALTER TABLE public.retailer_bell_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Retailer reads own bell marks" ON public.retailer_bell_reads;
CREATE POLICY "Retailer reads own bell marks" ON public.retailer_bell_reads
    FOR SELECT TO authenticated
    USING (retailer_id IN (SELECT r.id FROM public.retailers r WHERE r.profile_id = auth.uid()));

DROP POLICY IF EXISTS "Retailer inserts own bell marks" ON public.retailer_bell_reads;
CREATE POLICY "Retailer inserts own bell marks" ON public.retailer_bell_reads
    FOR INSERT TO authenticated
    WITH CHECK (retailer_id IN (SELECT r.id FROM public.retailers r WHERE r.profile_id = auth.uid()));

DROP POLICY IF EXISTS "Retailer updates own bell marks" ON public.retailer_bell_reads;
CREATE POLICY "Retailer updates own bell marks" ON public.retailer_bell_reads
    FOR UPDATE TO authenticated
    USING (retailer_id IN (SELECT r.id FROM public.retailers r WHERE r.profile_id = auth.uid()))
    WITH CHECK (retailer_id IN (SELECT r.id FROM public.retailers r WHERE r.profile_id = auth.uid()));

REVOKE ALL ON public.retailer_bell_reads FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.retailer_bell_reads TO authenticated;
