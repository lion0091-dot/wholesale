import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shop_token: string }>;
}): Promise<Metadata> {
  const { shop_token: shopToken } = await params;

  return { manifest: `/pwa/shop/${encodeURIComponent(shopToken)}` };
}

export default function ShopLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
