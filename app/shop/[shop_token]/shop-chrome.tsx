import Link from "next/link";
import type { ShopCustomer } from "@/lib/shop/catalog-types";
import type { Wholesaler } from "@/types/database";

/** 미니샵(모바일 웹 / 카카오 인앱 브라우저) 공통 레이아웃 토큰 */
export const SHOP_MAX_WIDTH = "600px";

export const shopPageStyle: React.CSSProperties = {
  maxWidth: SHOP_MAX_WIDTH,
  margin: "0 auto",
  minHeight: "100vh",
  backgroundColor: "#f8fafc",
};

export const cardStyle: React.CSSProperties = {
  backgroundColor: "#ffffff",
  borderRadius: "12px",
  border: "1px solid #e2e8f0",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
};

export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px",
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  fontSize: "13px",
  boxSizing: "border-box",
};

export const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 700,
  color: "#334155",
  marginBottom: "4px",
};

export function formatWon(amount: number): string {
  return `${Math.round(amount).toLocaleString()}원`;
}

interface ShopHeaderProps {
  wholesaler: Wholesaler;
  customer: ShopCustomer;
  /** 하위 페이지(장바구니/주문서)에서 상단에 노출할 단계 제목 */
  title?: string;
  /** 뒤로가기 링크 (없으면 미노출) */
  backHref?: string;
  children?: React.ReactNode;
}

/** 공급사 상호 + 접속 고객 배지 헤더 */
export function ShopHeader({
  wholesaler,
  customer,
  title,
  backHref,
  children,
}: ShopHeaderProps) {
  return (
    <header
      style={{
        backgroundColor: "#ffffff",
        padding: "20px 16px",
        borderBottom: "1px solid #e2e8f0",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      {backHref && (
        <Link
          href={backHref}
          style={{
            display: "inline-block",
            fontSize: "12px",
            fontWeight: 600,
            color: "#64748b",
            textDecoration: "none",
            marginBottom: "10px",
          }}
        >
          ← 이전
        </Link>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
        <div>
          <span style={{ fontSize: "11px", fontWeight: 700, color: "#dc2626", letterSpacing: "0.5px" }}>
            {title ?? "단골 전용 1:1 직거래 발주"}
          </span>
          <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", marginTop: "2px" }}>
            {wholesaler.business_name}
          </h1>
          <p style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
            대표자: {wholesaler.representative_name} | 사업자번호: {wholesaler.business_number}
          </p>
        </div>

        <span
          style={{
            flexShrink: 0,
            fontSize: "11px",
            fontWeight: 600,
            backgroundColor: customer.isLinked ? "#dcfce7" : "#f1f5f9",
            color: customer.isLinked ? "#166534" : "#475569",
            padding: "4px 8px",
            borderRadius: "12px",
            whiteSpace: "nowrap",
          }}
        >
          {customer.isLinked
            ? `${customer.restaurantName ?? "인증 바이어"} 접속중`
            : "미인증 손님 모드"}
        </span>
      </div>

      {children}
    </header>
  );
}

/** PRD Section 5 준수 — 폐쇄형 1:1 거래 고지 */
export function ShopFooter({ businessName }: { businessName: string }) {
  return (
    <footer
      style={{
        padding: "24px 16px",
        textAlign: "center",
        borderTop: "1px solid #e2e8f0",
        backgroundColor: "#ffffff",
        marginTop: "40px",
      }}
    >
      <p style={{ fontSize: "11px", color: "#94a3b8", lineHeight: 1.5 }}>
        본 상점은 <strong>{businessName}</strong>과 계약된 구매 회원(바이어)을 위한 비공개 1:1 발주 공간입니다.
        <br />
        타 도매업자에게 정보가 일체 공유되지 않습니다.
      </p>
    </footer>
  );
}
