import type { createClient } from "@/lib/supabase/server";
import type { ProductOption } from "./product-match";

type Supabase = Awaited<ReturnType<typeof createClient>>;

interface Filters {
  /** 이 축종의 상품만 — 스펙 매칭은 줄에 나온 축종의 상품만 있으면 된다. */
  categories?: readonly string[];
  /** 이 상품들만 — 상품을 고른 줄을 확인할 때는 그 상품 몇 개만 있으면 된다. */
  ids?: readonly string[];
}

/**
 * 발주서에서 고를 수 있는 상품 — 내 업체의 보관되지 않은 상품(판매중지 포함: 발주는 판매와 별개다).
 * DB 함수(list_product_options, 마이그레이션 139)로 읽는다: 테이블을 직접 읽으면 행마다 권한 검사가 돌아 5,000개에 1.3초 걸리고
 * 한 번에 1,000행에서 잘린다.
 */
export async function loadProductOptions(
  supabase: Supabase,
  wholesalerId: string,
  filters: Filters = {}
): Promise<ProductOption[]> {
  if ((filters.categories && filters.categories.length === 0) || (filters.ids && filters.ids.length === 0)) {
    return [];
  }

  const { data, error } = await supabase.rpc("list_product_options", {
    p_wholesaler_id: wholesalerId,
    p_categories: filters.categories ? [...filters.categories] : null,
    p_ids: filters.ids ? [...new Set(filters.ids)] : null,
  });

  if (error) {
    throw new Error(`상품 목록을 불러오지 못했습니다: ${error.message}`);
  }

  return (data ?? []) as ProductOption[];
}
