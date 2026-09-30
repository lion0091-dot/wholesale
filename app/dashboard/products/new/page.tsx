import { createClient } from "@/lib/supabase/server";
import { ProductFormView } from "../product-form-view";
import { fetchSubcategoriesByCategory } from "../get-subcategories";

export const metadata = {
  title: "신규 상품 등록 | 도매업체 통합관리시스템",
};

export default async function NewProductPage() {
  const supabase = await createClient();
  const [{ data }, subcategoriesByCategory] = await Promise.all([
    supabase.from("product_categories").select("name").order("sort_order", { ascending: true }),
    fetchSubcategoriesByCategory(supabase),
  ]);

  const categories = ((data ?? []) as Array<{ name: string }>).map((row) => row.name);

  return (
    <ProductFormView
      categories={categories}
      subcategoriesByCategory={subcategoriesByCategory}
    />
  );
}
