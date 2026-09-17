import type { createClient } from "@/lib/supabase/server";

/** 축종명 → 부위 목록. product_categories/product_subcategories 조인 결과를 폼에서 쓰기 좋은 모양으로 바꾼다. */
export async function fetchSubcategoriesByCategory(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<Record<string, string[]>> {
  const { data } = await supabase
    .from("product_subcategories")
    .select("name, sort_order, product_categories(name)")
    .order("sort_order", { ascending: true });

  const rows = (data ?? []) as Array<{
    name: string;
    product_categories: { name: string } | { name: string }[] | null;
  }>;

  const result: Record<string, string[]> = {};

  for (const row of rows) {
    const category = Array.isArray(row.product_categories)
      ? row.product_categories[0]
      : row.product_categories;

    if (!category?.name) continue;

    (result[category.name] ??= []).push(row.name);
  }

  return result;
}
