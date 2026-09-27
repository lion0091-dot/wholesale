-- 공급처 거래처 관리 (2026-09-27, 사장님 요청) — 공급처 이름을 손으로 치지 않고 목록에서 고르게 한다.
--
-- "OO축산"·"OO 축산"이 다른 거래처로 갈라지지 않게 이름 열쇠(name_key: 모든 공백 제거 + 소문자,
-- lib/livestock/supplier-name.ts의 supplierKey와 같은 규칙)를 DB가 계산하고 업체 안에서 유일하게 한다.
-- 명세서에 다르게 적히는 이름은 aliases에 둔다(겹침 검사는 앱이 한다).
-- 고객 관리(retailers — 우리가 물건을 파는 곳)와는 별개다: 여기는 물건을 사 오는 곳이다.
--
-- 이번 단계는 발주서(purchase_orders)만 공급처 ID로 잇는다. 전표(inbound_documents)의 공급처 이름은 입고 연결 단계에서 잇는다.
-- 기존 이름들(발주서·전표)은 이 마이그레이션이 거래처로 옮겨 담는다.

CREATE TABLE IF NOT EXISTS public.suppliers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wholesaler_id UUID NOT NULL REFERENCES public.wholesalers(id) ON DELETE CASCADE,
    name          TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    name_key      TEXT NOT NULL,
    phone         TEXT CHECK (phone IS NULL OR char_length(phone) <= 30),
    note          TEXT CHECK (note IS NULL OR char_length(note) <= 500),
    aliases       TEXT[] NOT NULL DEFAULT '{}',
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_wholesaler_name_key
    ON public.suppliers (wholesaler_id, name_key);

CREATE OR REPLACE FUNCTION public.suppliers_set_name_key()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.name := btrim(regexp_replace(NEW.name, '[[:space:] 　]+', ' ', 'g'));
    NEW.name_key := lower(regexp_replace(NEW.name, '[[:space:] 　]+', '', 'g'));

    IF NEW.name_key = '' THEN
        RAISE EXCEPTION 'SUPPLIER_NAME_EMPTY';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.suppliers_set_name_key() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_suppliers_name_key ON public.suppliers;
CREATE TRIGGER trg_suppliers_name_key
    BEFORE INSERT OR UPDATE OF name ON public.suppliers
    FOR EACH ROW EXECUTE FUNCTION public.suppliers_set_name_key();

DROP TRIGGER IF EXISTS trg_suppliers_updated_at ON public.suppliers;
CREATE TRIGGER trg_suppliers_updated_at
    BEFORE UPDATE ON public.suppliers
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Suppliers viewable by supplier staff" ON public.suppliers;
CREATE POLICY "Suppliers viewable by supplier staff" ON public.suppliers
    FOR SELECT USING (public.can_access_wholesaler(wholesaler_id));

DROP POLICY IF EXISTS "Suppliers managed by owner and manager" ON public.suppliers;
CREATE POLICY "Suppliers managed by owner and manager" ON public.suppliers
    FOR ALL USING (public.can_manage_wholesaler(wholesaler_id))
    WITH CHECK (public.can_manage_wholesaler(wholesaler_id));

COMMENT ON TABLE public.suppliers IS '공급사가 물건을 사 오는 공급처(거래처) 목록. 고객 관리(retailers)와 별개.';
COMMENT ON COLUMN public.suppliers.aliases IS '명세서에 다르게 적히는 이름들. 다른 거래처의 이름·별칭과 겹치는지는 앱이 검사한다.';

-- ------------------------------------------------------------------
-- 기존 이름 옮겨 담기: 발주서·전표에 적혀 있던 공급처 이름 → 거래처 (이름 열쇠가 같으면 하나로)
-- ------------------------------------------------------------------
INSERT INTO public.suppliers (wholesaler_id, name)
SELECT DISTINCT ON (wholesaler_id, lower(regexp_replace(supplier_name, '[[:space:] 　]+', '', 'g')))
       wholesaler_id, supplier_name
FROM (
    SELECT wholesaler_id, supplier_name FROM public.purchase_orders
    UNION ALL
    SELECT wholesaler_id, supplier_name FROM public.inbound_documents WHERE supplier_name IS NOT NULL
) names
WHERE btrim(supplier_name) <> ''
ORDER BY wholesaler_id, lower(regexp_replace(supplier_name, '[[:space:] 　]+', '', 'g')), supplier_name
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------
-- 발주서 → 공급처 ID
-- ------------------------------------------------------------------
ALTER TABLE public.purchase_orders
    ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES public.suppliers(id) ON DELETE RESTRICT;

UPDATE public.purchase_orders po
SET supplier_id = s.id
FROM public.suppliers s
WHERE po.supplier_id IS NULL
  AND s.wholesaler_id = po.wholesaler_id
  AND s.name_key = lower(regexp_replace(po.supplier_name, '[[:space:] 　]+', '', 'g'));

ALTER TABLE public.purchase_orders ALTER COLUMN supplier_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON public.purchase_orders (supplier_id);

-- 발주서의 공급처는 같은 업체의 거래처여야 한다 — 다른 업체 거래처를 붙이는 것을 DB가 막는다.
CREATE OR REPLACE FUNCTION public.enforce_purchase_order_supplier_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_owner UUID;
BEGIN
    SELECT wholesaler_id INTO v_owner FROM public.suppliers WHERE id = NEW.supplier_id;

    IF v_owner IS DISTINCT FROM NEW.wholesaler_id THEN
        RAISE EXCEPTION 'SUPPLIER_TENANT_MISMATCH';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_purchase_order_supplier_tenant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_purchase_order_supplier_tenant ON public.purchase_orders;
CREATE TRIGGER trg_purchase_order_supplier_tenant
    BEFORE INSERT OR UPDATE OF supplier_id, wholesaler_id ON public.purchase_orders
    FOR EACH ROW EXECUTE FUNCTION public.enforce_purchase_order_supplier_tenant();

COMMENT ON COLUMN public.purchase_orders.supplier_id IS '발주서의 공급처(suppliers). supplier_name은 발주 당시 이름의 스냅샷.';
