-- 공급처 발주서 (2026-09-27, 사장님 요청).
--
-- 공급사가 공급처에 내는 발주서 — "한우 등심 1++ 50kg" 같은 줄이 물건이 오기 전에 시스템에 있어야
-- 입고 때 발주서를 기준으로 맞춰 볼 수 있다(전표·바코드·이력번호가 없어도). 이 마이그레이션은 발주서를
-- 적어 두는 자리만 만든다 — 입고 스캔·전표 대조와의 연결은 아직 없다.
--
-- 줄은 상품 ID가 아니라 "스펙"(축종·부위·등급·원산지)을 적는다. 처음 취급하는 품목은 상품이 아직 없을 수 있고,
-- 소·돼지·닭/오리 상품은 이력 조회로만 만들어지기 때문이다. 상품과의 연결은 입고 연결 단계에서 한다.
-- 발주는 공급사 사무실 업무라 조회는 소속 직원 전원, 작성·수정은 owner/manager만(can_manage_wholesaler).

CREATE TABLE IF NOT EXISTS public.purchase_orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    supplier_name TEXT NOT NULL CHECK (char_length(btrim(supplier_name)) BETWEEN 1 AND 80),
    ordered_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_on   DATE,
    note          TEXT CHECK (note IS NULL OR char_length(note) <= 500),
    status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
    created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_wholesaler
    ON public.purchase_orders (wholesaler_id, ordered_on DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.purchase_order_lines (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
    wholesaler_id     UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    line_no           INTEGER NOT NULL CHECK (line_no > 0),
    category          TEXT NOT NULL CHECK (char_length(btrim(category)) > 0),
    subcategory       TEXT,
    grade             TEXT,
    origin            TEXT NOT NULL CHECK (char_length(btrim(origin)) > 0),
    quantity          NUMERIC(10, 2) NOT NULL CHECK (quantity > 0),
    unit              TEXT NOT NULL DEFAULT 'kg',
    unit_price        NUMERIC(12, 2) CHECK (unit_price IS NULL OR unit_price >= 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (purchase_order_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_order
    ON public.purchase_order_lines (purchase_order_id);

-- 줄의 wholesaler_id는 헤더와 같아야 한다 — 다른 업체 발주서에 줄을 끼워 넣는 것을 DB가 막는다.
CREATE OR REPLACE FUNCTION public.enforce_purchase_order_line_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_owner UUID;
BEGIN
    SELECT wholesaler_id INTO v_owner FROM public.purchase_orders WHERE id = NEW.purchase_order_id;

    IF v_owner IS DISTINCT FROM NEW.wholesaler_id THEN
        RAISE EXCEPTION 'PURCHASE_ORDER_TENANT_MISMATCH';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_purchase_order_line_tenant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_purchase_order_line_tenant ON public.purchase_order_lines;
CREATE TRIGGER trg_purchase_order_line_tenant
    BEFORE INSERT OR UPDATE ON public.purchase_order_lines
    FOR EACH ROW EXECUTE FUNCTION public.enforce_purchase_order_line_tenant();

DROP TRIGGER IF EXISTS trg_purchase_orders_updated_at ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_updated_at
    BEFORE UPDATE ON public.purchase_orders
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Purchase orders viewable by supplier staff" ON public.purchase_orders;
CREATE POLICY "Purchase orders viewable by supplier staff" ON public.purchase_orders
    FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

DROP POLICY IF EXISTS "Purchase orders managed by owner and manager" ON public.purchase_orders;
CREATE POLICY "Purchase orders managed by owner and manager" ON public.purchase_orders
    FOR ALL USING (public.can_manage_wholesaler(wholesaler_id))
    WITH CHECK (public.can_manage_wholesaler(wholesaler_id));

DROP POLICY IF EXISTS "Purchase order lines viewable by supplier staff" ON public.purchase_order_lines;
CREATE POLICY "Purchase order lines viewable by supplier staff" ON public.purchase_order_lines
    FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

DROP POLICY IF EXISTS "Purchase order lines managed by owner and manager" ON public.purchase_order_lines;
CREATE POLICY "Purchase order lines managed by owner and manager" ON public.purchase_order_lines
    FOR ALL USING (public.can_manage_wholesaler(wholesaler_id))
    WITH CHECK (public.can_manage_wholesaler(wholesaler_id));

COMMENT ON TABLE public.purchase_orders IS '공급사가 공급처에 내는 발주서 헤더. 고객→공급사 주문(orders)과 별개.';
COMMENT ON TABLE public.purchase_order_lines IS '발주서 줄 — 상품 ID가 아닌 스펙(축종·부위·등급·원산지)과 수량(kg). 입고 연결은 후속 단계.';
