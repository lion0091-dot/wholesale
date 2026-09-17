-- 주문 통계를 상품명 자유 텍스트 매칭이 아니라 축종/부위 2단계 체계로 집계할 수 있도록,
-- 주문 시점의 카테고리/부위를 order_items에도 스냅샷으로 남긴다.
-- (products.category/subcategory는 이후 바뀔 수 있어 order_items 쪽 값이 "그 주문 당시" 기준이다)
alter table public.order_items
    add column category text,
    add column subcategory text;

-- 기존 주문 이력은 스냅샷이 없으니, product_id가 가리키는 상품의 "현재" 카테고리로
-- 최선을 다해 보정한다(products는 ON DELETE RESTRICT라 항상 존재함). 완벽한 시점
-- 스냅샷은 아니지만 없는 것보다 통계에 훨씬 유용하다.
update public.order_items oi
set category = p.category,
    subcategory = p.subcategory
from public.products p
where p.id = oi.product_id
  and oi.category is null;
