import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "공급사 온보딩 | B2B 육류 도매 발주 시스템",
  description: "공급사 조직을 생성해 백오피스 사용을 시작합니다.",
};

/**
 * 온보딩 전용 레이아웃.
 *
 * 조직이 없는 계정은 백오피스(사이드바/조직 헤더)를 쓸 수 없으므로
 * /dashboard 레이아웃과 완전히 분리된 독립 화면으로 제공한다.
 */
export default function OnboardingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div style={{ minHeight: "100%", backgroundColor: "#f8fafc" }}>
      <header
        style={{
          borderBottom: "1px solid #e2e8f0",
          backgroundColor: "#ffffff",
        }}
      >
        <div
          style={{
            maxWidth: "680px",
            margin: "0 auto",
            padding: "14px 20px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ fontSize: "18px" }}>🥩</span>
          <span style={{ fontSize: "14px", fontWeight: 800, color: "#0f172a" }}>
            B2B 육류 도매 발주 시스템
          </span>
          <span
            style={{
              marginLeft: "auto",
              fontSize: "11px",
              fontWeight: 700,
              color: "#92400e",
              backgroundColor: "#fef3c7",
              border: "1px solid #fde68a",
              borderRadius: "999px",
              padding: "3px 10px",
            }}
          >
            조직 설정 필요
          </span>
        </div>
      </header>

      <main style={{ maxWidth: "680px", margin: "0 auto", padding: "32px 20px 48px" }}>
        {children}
      </main>
    </div>
  );
}
