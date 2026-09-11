import { getSupplierScope } from "@/lib/supplier/scope";
import { ProductFormView } from "../product-form-view";

export const metadata = {
  title: "신규 상품 등록 | 공급사 백오피스",
};

export default async function NewProductPage() {
  const scope = await getSupplierScope();

  return <ProductFormView isDemoMode={!scope?.wholesalerId} />;
}
