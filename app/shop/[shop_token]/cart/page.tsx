import { loadShopCatalog } from "@/lib/shop/catalog";
import { requireBuyerConsent } from "@/lib/auth/buyer-auth";
import { CartView } from "./cart-view";

interface PageProps {
  params: Promise<{
    shop_token: string;
  }>;
}

export default async function CartPage({ params }: PageProps) {
  const { shop_token } = await params;

  await requireBuyerConsent(shop_token);

  const catalog = await loadShopCatalog(shop_token);

  return <CartView catalog={catalog} />;
}
