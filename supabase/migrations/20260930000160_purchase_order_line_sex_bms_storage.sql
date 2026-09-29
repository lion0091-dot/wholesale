-- ====================================================================
-- 발주서 줄에 성별·BMS·냉장/냉동 추가 (2026-09-30, 사장님 지적).
--
-- 배경: 159가 상품 정체성에 성별·BMS·냉장/냉동을 추가했지만, 발주서 줄(purchase_order_lines)과
-- 카톡 발주 문구(buildPurchaseOrderMessage)는 여전히 축종·품종·부위·등급·원산지만 다뤘다.
-- 그 결과 공급처에게 나가는 실제 발주 문구에 성별·BMS·냉장/냉동이 전혀 실리지 않아
-- "어느 변형을 보내야 할지 공급처가 알 방법이 없는" 상태였다. TS 쪽(lib/purchase-orders/*,
-- app/dashboard/purchase-orders/*)에서 이 세 칸을 채우도록 고치는 것과 짝을 이루는 DB 변경이다.
--
-- 겸사겸사 고침: purchase_order_lines_breed_valid가 "category='소'면 breed는 항상 NOT NULL"을
-- 요구해서, 수입 원산지 소 발주 줄(품종 개념 없음 — 2026-09-28 결정)에서 품종을 비우면
-- CHECK 위반으로 저장이 실패하는 버그가 있었다(products 테이블의 완화된 CHECK와 안 맞았다).
-- products와 같은 패턴(breed IS NULL 허용)으로 맞춘다.
-- ====================================================================

ALTER TABLE public.purchase_order_lines DROP CONSTRAINT IF EXISTS purchase_order_lines_breed_valid;
ALTER TABLE public.purchase_order_lines
    ADD CONSTRAINT purchase_order_lines_breed_valid CHECK (breed IS NULL OR (category = '소' AND breed IN ('한우', '육우', '젖소')));

ALTER TABLE public.purchase_order_lines
    ADD COLUMN IF NOT EXISTS sex TEXT,
    ADD COLUMN IF NOT EXISTS bms TEXT,
    ADD COLUMN IF NOT EXISTS storage_state TEXT,
    ADD CONSTRAINT purchase_order_lines_sex_valid CHECK (sex IS NULL OR (category = '소' AND sex IN ('거세', '암'))),
    ADD CONSTRAINT purchase_order_lines_bms_valid CHECK (bms IS NULL OR (category = '소' AND grade = '1++' AND bms IN ('7', '8', '9'))),
    ADD CONSTRAINT purchase_order_lines_storage_state_valid CHECK (
        storage_state IS NULL OR (category IN ('소', '돼지', '닭', '오리') AND storage_state IN ('냉장', '냉동'))
    );

COMMENT ON COLUMN public.purchase_order_lines.sex IS '소만: 거세/암. 국내산 소는 필수(상품 정체성 키, 159와 같은 규칙).';
COMMENT ON COLUMN public.purchase_order_lines.bms IS '소 1++ 등급만: 7/8/9. 항상 선택(등급이 1++일 때만 의미가 있다).';
COMMENT ON COLUMN public.purchase_order_lines.storage_state IS '소·돼지·닭·오리: 냉장/냉동. 원산지와 무관하게 필수(상품 정체성 키).';

-- list_product_options: 발주서 줄 선택 화면(NewProductPanel)이 기존 상품을 스펙으로 찾을 때
-- 성별·BMS·냉장/냉동까지 비교해야 정확한 변형을 고른다. 함수 본문은 로컬 DB의
-- pg_get_functiondef(139 적용 후) 기준으로 패치했다(칸 3개만 더함).
CREATE OR REPLACE FUNCTION public.list_product_options(p_wholesaler_id uuid, p_categories text[] DEFAULT NULL::text[], p_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.can_access_wholesaler(p_wholesaler_id) THEN
        RAISE EXCEPTION 'NOT_ALLOWED';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(
                   jsonb_build_object(
                       'id', t.id,
                       'name', t.name,
                       'category', t.category,
                       'subcategory', t.subcategory,
                       'grade', t.grade,
                       'breed', t.breed,
                       'sex', t.sex,
                       'bms', t.bms,
                       'storageState', t.storage_state,
                       'origin', t.origin
                   )
                   ORDER BY t.category, t.name, t.id
               )
        FROM (
            SELECT p.id, p.name, p.category, p.subcategory, p.grade, p.breed, p.sex, p.bms, p.storage_state, p.origin
            FROM public.products p
            WHERE p.wholesaler_id = p_wholesaler_id
              AND p.archived_at IS NULL
              AND (p_categories IS NULL OR p.category = ANY (p_categories))
              AND (p_ids IS NULL OR p.id = ANY (p_ids))
            ORDER BY p.category, p.name, p.id
            LIMIT 20000
        ) t
    ), '[]'::jsonb);
END;
$function$;
