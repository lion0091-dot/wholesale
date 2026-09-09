import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "B2B 육류 도매 발주 시스템",
  description: "도매업체와 단골 식당을 위한 1:1 모바일 발주 플랫폼",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
