import { loadShopCatalog } from "@/lib/shop/catalog";
import { CartView } from "./cart-view";

interface PageProps {
  params: Promise<{
    shop_token: string;
  }>;
}

export default async function CartPage({ params }: PageProps) {
  const { shop_token } = await params;
  const catalog = await loadShopCatalog(shop_token);

  return <CartView catalog={catalog} />;
}
