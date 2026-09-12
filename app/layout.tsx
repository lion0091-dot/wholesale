import type { Metadata } from "next";
import "./globals.css";
import { LegalFooter } from "@/components/legal-footer";

export const metadata: Metadata = {
  title: "미트 파트너스",
  description: "도매업체와 바이어(구매 회원)를 위한 1:1 모바일 발주 플랫폼",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <div style={{ flex: 1 }}>{children}</div>
        <LegalFooter />
      </body>
    </html>
  );
}
