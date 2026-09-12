import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupplierScope } from "@/lib/supplier/scope";
import { DEMO_PRODUCTS } from "@/lib/demo/supplier-samples";
import { ProductFormView } from "../../product-form-view";
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

  if (scope?.wholesalerId) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("products")
      .select("*")
      .eq("id", id)
      .eq("wholesaler_id", scope.wholesalerId)
      .maybeSingle();

    if (data) {
      return <ProductFormView product={data as Product} />;
    }
  }

  // 데모 모드에서는 샘플 상품으로 수정 폼 UI를 확인할 수 있다.
  const demoProduct = DEMO_PRODUCTS.find((product) => product.id === id);

  if (!demoProduct) {
    notFound();
  }

  return <ProductFormView product={demoProduct} isDemoMode />;
}
