import { createClient } from "@/lib/supabase/server";
import { loadPublicShopIdentity } from "@/lib/auth/buyer-auth";
import { loadShopCatalog } from "@/lib/shop/catalog";
import { KakaoLoginGate } from "./kakao-login-gate";
import { ShopView } from "./shop-view";

interface PageProps {
  params: Promise<{
    shop_token: string;
  }>;
  searchParams: Promise<{
    auth_error?: string;
    auth_message?: string;
  }>;
}

export default async function MiniShopPage({ params, searchParams }: PageProps) {
  const { shop_token } = await params;
  const { auth_message } = await searchParams;

  // 미니샵 진입 게이트 — 카카오 로그인이 확인되기 전에는 카탈로그를 열지 않는다.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const shop = await loadPublicShopIdentity(shop_token);

    return (
      <KakaoLoginGate
        shopToken={shop_token}
        businessName={shop?.businessName ?? null}
        returnPath={`/shop/${shop_token}`}
        initialError={auth_message ?? null}
      />
    );
  }

  const catalog = await loadShopCatalog(shop_token);

  return <ShopView catalog={catalog} authMessage={auth_message ?? null} />;
}
