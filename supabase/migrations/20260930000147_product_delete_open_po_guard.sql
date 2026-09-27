-- code-review(74d8069^..e16a00e)에서 발견 — deleteProductAction의 "열린 발주서 줄이 있으면 삭제 거부" 확인이
-- 앱 코드에서 SELECT 한 뒤 별도 왕복으로 DELETE를 보내는 방식이라, 그 사이(다른 요청이 같은 상품으로 새
-- 발주서 줄을 만드는 순간)에 걸리면 확인을 통과한 뒤 삭제가 그대로 진행돼 방금 만든 발주서 줄이 조용히
-- 고아가 됐다(purchase_order_lines.product_id는 ON DELETE SET NULL이라 DB가 막지 않음).
--
-- 앱 쪽 사전 확인은 빠른 안내용으로 남겨 두고, 실제 강제는 DB 트리거로 옮겨 삭제와 같은 트랜잭션 안에서
-- 검사하게 한다 — 앱 왕복 사이의 틈이 없어진다.
CREATE OR REPLACE FUNCTION public.prevent_delete_product_with_open_po_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.purchase_order_lines l
        JOIN public.purchase_orders po ON po.id = l.purchase_order_id
        WHERE l.product_id = OLD.id AND po.status = 'OPEN'
    ) THEN
        RAISE EXCEPTION 'PRODUCT_HAS_OPEN_PURCHASE_ORDER_LINE';
    END IF;

    RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_delete_product_with_open_po_line ON public.products;
CREATE TRIGGER trg_prevent_delete_product_with_open_po_line
    BEFORE DELETE ON public.products
    FOR EACH ROW EXECUTE FUNCTION public.prevent_delete_product_with_open_po_line();
