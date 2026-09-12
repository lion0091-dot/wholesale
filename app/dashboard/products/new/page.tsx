import { getSupplierScope } from "@/lib/supplier/scope";
import { ProductFormView } from "../product-form-view";

export const metadata = {
  title: "신규 상품 등록 | 도매업체 통합관리시스템",
};

export default async function NewProductPage() {
  const scope = await getSupplierScope();

  return <ProductFormView isDemoMode={!scope?.wholesalerId} />;
}
