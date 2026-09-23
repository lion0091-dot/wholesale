import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { ProductFormView } from "../../product-form-view";
import { fetchSubcategoriesByCategory } from "../../get-subcategories";
import type { Product } from "@/types/database";

export const metadata = {
  title: "상품 정보 수정 | 도매업체 통합관리시스템",
};

interface EditProductPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditProductPage({ params }: EditProductPageProps) {
  const { id } = await params;
  const scope = await getSupplierScope();
  const supabase = await createClient();
  const { data: categoryRows } = await supabase
    .from("product_categories")
    .select("name")
    .order("sort_order", { ascending: true });
  const categories = ((categoryRows ?? []) as Array<{ name: string }>).map((row) => row.name);
  const subcategoriesByCategory = await fetchSubcategoriesByCategory(supabase);

  if (!scope?.wholesalerId) {
    notFound();
  }

  const { data } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .eq("wholesaler_id", scope.wholesalerId)
    .maybeSingle();

  if (!data) {
    notFound();
  }

  return (
    <ProductFormView
      product={data as Product}
      categories={categories}
      subcategoriesByCategory={subcategoriesByCategory}
    />
  );
}
