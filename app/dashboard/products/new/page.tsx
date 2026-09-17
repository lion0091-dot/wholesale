import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { ProductFormView } from "../product-form-view";

export const metadata = {
  title: "신규 상품 등록 | 도매업체 통합관리시스템",
};

export default async function NewProductPage() {
  const scope = await getSupplierScope();
  const supabase = await createClient();
  const { data } = await supabase
    .from("product_categories")
    .select("name")
    .order("sort_order", { ascending: true });

  const categories = ((data ?? []) as Array<{ name: string }>).map((row) => row.name);

  return <ProductFormView isDemoMode={!scope?.wholesalerId} categories={categories} />;
}
