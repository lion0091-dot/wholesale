import { loadShopCatalog } from "@/lib/shop/catalog";
import { loadShopOrderHistory } from "@/lib/shop/order-history";
import { OrderHistoryView } from "./order-history-view";

interface PageProps {
  params: Promise<{
    shop_token: string;
  }>;
}

export default async function ShopOrderHistoryPage({ params }: PageProps) {
  const { shop_token } = await params;
  const catalog = await loadShopCatalog(shop_token);
  const history = await loadShopOrderHistory(catalog);

  return <OrderHistoryView catalog={catalog} history={history} />;
}
