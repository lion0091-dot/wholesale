import { createClient } from "@/lib/supabase/server";
import { loadPublicShopIdentity } from "@/lib/auth/buyer-auth";
import { loadShopCatalog } from "@/lib/shop/catalog";
import { resolveDisplayName } from "@/lib/auth/display-name";
import { KakaoLoginGate } from "./kakao-login-gate";
import { BuyerConsentGate } from "./buyer-consent-gate";
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

  // 바이어(구매 회원) 계정만 대상. 공급사/관리자가 자기 초대 링크를 열어본
  // 경우는 카탈로그 로더가 GUEST_CUSTOMER로 처리하므로 동의 게이트를 거치지 않는다.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, terms_agreed_at")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role === "retailer" && !profile.terms_agreed_at) {
    const displayName = resolveDisplayName(null, user.user_metadata);

    return <BuyerConsentGate shopToken={shop_token} displayName={displayName} />;
  }

  const catalog = await loadShopCatalog(shop_token, { allowPreview: true });

  return <ShopView catalog={catalog} authMessage={auth_message ?? null} />;
}
