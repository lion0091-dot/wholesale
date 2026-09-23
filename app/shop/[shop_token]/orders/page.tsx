import { loadShopCatalog } from "@/lib/shop/catalog";
import { loadShopOrderHistory } from "@/lib/shop/order-history";
import { DEFAULT_ORDER_HISTORY_DAYS } from "@/lib/orders/history-range";
import { requireBuyerConsent } from "@/lib/auth/buyer-auth";
import { isSweetTrackerConfigured } from "@/lib/verification/sweettracker";
import { signExternalOpenToken } from "@/lib/pdf/external-open-token";
import { OrderHistoryView } from "./order-history-view";

interface PageProps {
  params: Promise<{
    shop_token: string;
  }>;
}

export default async function ShopOrderHistoryPage({ params }: PageProps) {
  const { shop_token } = await params;

  await requireBuyerConsent(shop_token);

  const catalog = await loadShopCatalog(shop_token);
  const history = await loadShopOrderHistory(catalog, { rangeDays: DEFAULT_ORDER_HISTORY_DAYS });

  // 카카오 인앱 브라우저 "외부에서 열기" 전용 — 세션 쿠키 없이도 인가되는 단발성 토큰.
  // 거래 관계가 없는(미연결) 고객은 발급하지 않고, 버튼은 기존 href로 폴백한다.
  const statementExternalOpenHrefByOrderId: Record<string, string> = {};

  if (catalog.customer.retailerId) {
    for (const order of history.orders) {
      const token = signExternalOpenToken({
        kind: "buyer-statement",
        orderId: order.id,
        wholesalerId: catalog.wholesaler.id,
        retailerId: catalog.customer.retailerId,
      });

      if (token) {
        statementExternalOpenHrefByOrderId[order.id] = `/doc/${token}`;
      }
    }
  }

  return (
    <OrderHistoryView
      catalog={catalog}
      history={history}
      initialRangeDays={DEFAULT_ORDER_HISTORY_DAYS}
      sweetTrackerConfigured={isSweetTrackerConfigured()}
      statementExternalOpenHrefByOrderId={statementExternalOpenHrefByOrderId}
    />
  );
}
