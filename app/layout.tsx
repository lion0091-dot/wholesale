import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LegalFooter } from "@/components/legal-footer";
import { StagingBanner } from "@/components/staging-banner";

export const viewport: Viewport = {
  themeColor: "#dc2626",
};

export const metadata: Metadata = {
  title: "미트 파트너스",
  appleWebApp: {
    capable: true,
    title: "미트 파트너스",
    statusBarStyle: "default",
  },
  description: "도매업체와 고객(소매)를 위한 1:1 모바일 발주 플랫폼",
  openGraph: {
    title: "미트 파트너스",
    description: "도매업체와 고객(소매)를 위한 1:1 모바일 발주 플랫폼",
    type: "website",
    locale: "ko_KR",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <StagingBanner />
        <div style={{ flex: 1 }}>{children}</div>
        <LegalFooter />
      </body>
    </html>
  );
}
