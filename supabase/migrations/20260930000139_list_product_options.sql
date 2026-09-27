-- 발주서 품목 목록용 상품 조회 (2026-09-28, 부하 점검에서 발견).
--
-- 문제: products의 SELECT 정책이 행마다 can_access_wholesaler()를 부른다. 상품 5,000개를 한꺼번에 읽으면 권한 검사만 1.3초(관리자 키로 같은 조회는 35ms)
--       걸려서 발주서 화면을 열 때마다 느리다. 또 PostgREST가 한 번에 1,000행까지만 돌려줘 상품이 1,000개를 넘는 업체는 목록이 조용히 잘렸다.
-- 해결: 권한을 한 번만 검사하고(can_access_wholesaler — 소속 직원·대표·super_admin, 정책의 첫 갈래와 같은 범위) 내 업체의 보관되지 않은 상품을
--       JSON 배열 하나로 돌려준다. 고객(바이어) 갈래("판매중·가격 있는 상품")는 이 함수의 대상이 아니라 호출이 거부된다.
-- 필터: 축종 목록(스펙 매칭용 — 줄에 나온 키 축종만) / 상품 ID 목록(고른 상품 확인용). 둘 다 없으면 전부.

CREATE OR REPLACE FUNCTION public.list_product_options(
    p_wholesaler_id uuid,
    p_categories text[] DEFAULT NULL,
    p_ids uuid[] DEFAULT NULL
)
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
                       'origin', t.origin
                   )
                   ORDER BY t.category, t.name, t.id
               )
        FROM (
            SELECT p.id, p.name, p.category, p.subcategory, p.grade, p.origin
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

REVOKE EXECUTE ON FUNCTION public.list_product_options(uuid, text[], uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_product_options(uuid, text[], uuid[]) TO authenticated;
