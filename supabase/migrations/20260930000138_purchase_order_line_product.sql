-- 발주서 줄에 상품 연결 (2026-09-28, 사장님 결정: 발주서에서 등록된 상품을 한 줄로 골라 넣는다).
--
-- 줄은 여전히 스펙(축종·부위·등급·원산지)을 스냅샷으로 들고 있다 — 상품이 나중에 바뀌어도 그날의 발주 내용이 남게 하려는 것이다.
-- product_id는 "이 줄이 어느 상품인가"의 연결이라 비어 있을 수 있다(엑셀로 올렸는데 등록된 상품이 없는 줄, 연결 도입 전 발주서).
-- 상품을 지우면(기록 없는 상품만 지워진다) 줄은 스펙만 남기고 연결만 끊는다.

ALTER TABLE public.purchase_order_lines
    ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_product
    ON public.purchase_order_lines (product_id)
    WHERE product_id IS NOT NULL;

-- 줄의 상품은 줄과 같은 업체의 것이어야 한다 — 다른 업체 상품을 끼워 넣는 것을 DB가 막는다.
-- 본문은 로컬 DB의 pg_get_functiondef 결과를 기준으로 패치했다(135의 것에 상품 검사만 더함).
CREATE OR REPLACE FUNCTION public.enforce_purchase_order_line_tenant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_owner UUID;
BEGIN
    SELECT wholesaler_id INTO v_owner FROM public.purchase_orders WHERE id = NEW.purchase_order_id;

    IF v_owner IS DISTINCT FROM NEW.wholesaler_id THEN
        RAISE EXCEPTION 'PURCHASE_ORDER_TENANT_MISMATCH';
    END IF;

    IF NEW.product_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.products p WHERE p.id = NEW.product_id AND p.wholesaler_id = NEW.wholesaler_id
       ) THEN
        RAISE EXCEPTION 'PURCHASE_ORDER_PRODUCT_MISMATCH';
    END IF;

    RETURN NEW;
END;
$function$;
