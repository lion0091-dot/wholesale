import { buildManifest, manifestResponse } from "@/lib/pwa/manifest";

/** 고객 미니샵 홈 화면 앱 설정: 가게(토큰)마다 그 가게 화면이 시작 화면이다. */
export async function GET(_request: Request, { params }: { params: Promise<{ shop_token: string }> }) {
  const { shop_token: shopToken } = await params;
  const startUrl = `/shop/${encodeURIComponent(shopToken)}`;

  return manifestResponse(buildManifest({ id: startUrl, start_url: startUrl }));
}
