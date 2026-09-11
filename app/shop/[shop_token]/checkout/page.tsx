import { loadShopCatalog } from "@/lib/shop/catalog";
import { CheckoutView } from "./checkout-view";

interface PageProps {
  params: Promise<{
    shop_token: string;
  }>;
}

export default async function CheckoutPage({ params }: PageProps) {
  const { shop_token } = await params;
  const catalog = await loadShopCatalog(shop_token);

  return <CheckoutView catalog={catalog} />;
}
