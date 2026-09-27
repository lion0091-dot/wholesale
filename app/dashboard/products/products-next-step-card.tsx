"use client";

import Link from "next/link";
import {
  PRODUCTS_ANCHORS,
  PRODUCTS_OPEN_PRICE_PANEL_EVENT,
  type ProductsNextStep,
} from "@/lib/products/products-next-step";

/** 판매가 일괄 등록 칸은 기본 접혀 있어서, 그리로 보낼 땐 펴 달라는 신호를 같이 보낸다. */
function openPricePanelIfTargeted(href: string) {
  if (href === PRODUCTS_ANCHORS.priceBulk) {
    window.dispatchEvent(new Event(PRODUCTS_OPEN_PRICE_PANEL_EVENT));
  }
}

/** 상품 관리 화면 맨 위 "지금 할 일" 카드 — 여러 문제가 있어도 하나만 강조한다. */
export function ProductsNextStepCard({ step }: { step: ProductsNextStep | null }) {
  if (!step) return null;

  return (
    <section
      id="products-next-step"
      aria-label="지금 할 일"
      style={{
        scrollMarginTop: "12px",
        border: "1px solid #93c5fd",
        backgroundColor: "#eff6ff",
        borderRadius: "12px",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <span style={{ fontSize: "12px", fontWeight: 700, color: "#1d4ed8" }}>지금 할 일</span>
      <div>
        <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{step.title}</div>
        <div style={{ fontSize: "12px", color: "#475569", marginTop: "3px", lineHeight: 1.5 }}>{step.detail}</div>
      </div>
      <Link
        href={step.href}
        onClick={() => openPricePanelIfTargeted(step.href)}
        style={{
          display: "block",
          textAlign: "center",
          backgroundColor: "#2563eb",
          color: "#ffffff",
          fontSize: "14px",
          fontWeight: 800,
          padding: "9px 14px",
          borderRadius: "10px",
          textDecoration: "none",
        }}
      >
        {step.buttonLabel}
      </Link>
      {step.secondaries.map((link) => (
        <Link
          key={link.label}
          href={link.href}
          onClick={() => openPricePanelIfTargeted(link.href)}
          style={{ fontSize: "12px", color: "#1d4ed8", textAlign: "center", textDecoration: "underline" }}
        >
          {link.label}
        </Link>
      ))}
    </section>
  );
}
