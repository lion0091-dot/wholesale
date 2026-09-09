"use client";

import { useState } from "react";
import type { Product, Wholesaler } from "@/types/database";

interface ShopViewProps {
  wholesaler: Wholesaler;
  products: Product[];
  isLoggedIn: boolean;
  restaurantName?: string | null;
}

export function ShopView({ wholesaler, products, isLoggedIn, restaurantName }: ShopViewProps) {
  const [activeTab, setActiveTab] = useState<"normal" | "secret">("normal");
  const [selectedCategory, setSelectedCategory] = useState<string>("전체");

  const categories = ["전체", "소", "돼지", "닭/오리", "가공육/기타"];

  // 탭에 따라 상품 필터링
  const tabFilteredProducts = products.filter((p) =>
    activeTab === "normal" ? !p.is_secret_deal : p.is_secret_deal
  );

  // 카테고리 필터링
  const displayedProducts = tabFilteredProducts.filter((p) => {
    if (selectedCategory === "전체") return true;
    if (selectedCategory === "가공육/기타") return !["소", "돼지", "닭/오리"].includes(p.category);
    return p.category === selectedCategory;
  });

  return (
    <div style={{ maxWidth: "600px", margin: "0 auto", minHeight: "100vh", backgroundColor: "#f8fafc" }}>
      {/* 도매업체 헤더 */}
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <span style={{ fontSize: "11px", fontWeight: 700, color: "#dc2626", letterSpacing: "0.5px" }}>
              단골 전용 1:1 직거래 발주
            </span>
            <h1 style={{ fontSize: "20px", fontWeight: 800, color: "#0f172a", marginTop: "2px" }}>
              {wholesaler.business_name}
            </h1>
            <p style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
              대표자: {wholesaler.representative_name} | 사업자번호: {wholesaler.business_number}
            </p>
          </div>

          <div style={{ textAlign: "right" }}>
            {isLoggedIn ? (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  backgroundColor: "#dcfce7",
                  color: "#166534",
                  padding: "4px 8px",
                  borderRadius: "12px",
                }}
              >
                {restaurantName || "단골 식당"} 접속중
              </span>
            ) : (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  backgroundColor: "#f1f5f9",
                  color: "#475569",
                  padding: "4px 8px",
                  borderRadius: "12px",
                }}
              >
                미인증 손님 모드
              </span>
            )}
          </div>
        </div>

        {/* 탭 전환 (일반 상품 vs 시크릿 딜 룸) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "16px" }}>
          <button
            onClick={() => setActiveTab("normal")}
            style={{
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              fontSize: "14px",
              fontWeight: 700,
              cursor: "pointer",
              backgroundColor: activeTab === "normal" ? "#0f172a" : "#f1f5f9",
              color: activeTab === "normal" ? "#ffffff" : "#64748b",
              transition: "all 0.15s ease",
            }}
          >
            기본 납품 품목
          </button>
          <button
            onClick={() => setActiveTab("secret")}
            style={{
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              fontSize: "14px",
              fontWeight: 700,
              cursor: "pointer",
              backgroundColor: activeTab === "secret" ? "#dc2626" : "#fee2e2",
              color: activeTab === "secret" ? "#ffffff" : "#b91c1c",
              transition: "all 0.15s ease",
            }}
          >
            🔥 시크릿 특가 룸
          </button>
        </div>
      </header>

      {/* 본문 콘텐츠 영역 */}
      <div style={{ padding: "16px" }}>
        {/* 옵션 B: 비로그인 상태에서 시크릿 딜 탭 클릭 시 안내 배너 */}
        {activeTab === "secret" && !isLoggedIn ? (
          <div
            style={{
              backgroundColor: "#ffffff",
              padding: "36px 20px",
              borderRadius: "12px",
              textAlign: "center",
              border: "1px solid #fecaca",
              boxShadow: "0 2px 4px rgba(0,0,0,0.03)",
              marginTop: "20px",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>🔒</div>
            <h3 style={{ fontSize: "17px", fontWeight: 700, color: "#991b1b", marginBottom: "6px" }}>
              단골 식당 전용 시크릿 딜 룸
            </h3>
            <p style={{ fontSize: "13px", color: "#475569", lineHeight: "1.6", marginBottom: "20px" }}>
              정규 시장 가격 붕괴를 방지하기 위해 <strong>인증된 단골 식당</strong>에게만 한정 수량 당일 마감 특가 고기가 공개됩니다.
            </p>
            <button
              onClick={() => alert("Phase 3에서 카카오 1초 간편인증 및 발주 기능이 연결됩니다.")}
              style={{
                backgroundColor: "#fee500",
                color: "#181600",
                fontWeight: 700,
                fontSize: "14px",
                padding: "12px 24px",
                borderRadius: "8px",
                border: "none",
                cursor: "pointer",
                boxShadow: "0 2px 4px rgba(0,0,0,0.05)",
              }}
            >
              카카오 1초 로그인하고 특가 보기
            </button>
          </div>
        ) : (
          <>
            {/* 카테고리 필터 바 */}
            <div style={{ display: "flex", gap: "6px", overflowX: "auto", paddingBottom: "12px", marginBottom: "12px" }}>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "20px",
                    border: "1px solid",
                    borderColor: selectedCategory === cat ? "#0f172a" : "#e2e8f0",
                    backgroundColor: selectedCategory === cat ? "#0f172a" : "#ffffff",
                    color: selectedCategory === cat ? "#ffffff" : "#475569",
                    fontSize: "12px",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* 상품 카드 목록 */}
            {displayedProducts.length === 0 ? (
              <div style={{ textAlign: "center", padding: "48px 16px", background: "#ffffff", borderRadius: "12px", border: "1px dashed #cbd5e1" }}>
                <p style={{ color: "#64748b", fontSize: "14px" }}>현재 등록된 상품이 없습니다.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gap: "12px" }}>
                {displayedProducts.map((product) => (
                  <div
                    key={product.id}
                    style={{
                      backgroundColor: "#ffffff",
                      borderRadius: "12px",
                      padding: "16px",
                      border: "1px solid #e2e8f0",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              color: product.is_secret_deal ? "#b91c1c" : "#475569",
                              backgroundColor: product.is_secret_deal ? "#fee2e2" : "#f1f5f9",
                              padding: "2px 6px",
                              borderRadius: "4px",
                            }}
                          >
                            {product.category}
                          </span>
                          <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>{product.name}</h3>
                        </div>
                        <p style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
                          원산지: {product.origin} {product.grade ? `| 등급: ${product.grade}` : ""}
                        </p>
                      </div>

                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: "17px", fontWeight: 800, color: product.is_secret_deal ? "#dc2626" : "#0f172a" }}>
                          {Number(product.base_price).toLocaleString()}원
                          <span style={{ fontSize: "12px", fontWeight: 400, color: "#64748b", marginLeft: "2px" }}>/ {product.unit}</span>
                        </div>
                        <div style={{ fontSize: "11px", color: product.stock_quantity > 0 ? "#166534" : "#dc2626", fontWeight: 600, marginTop: "2px" }}>
                          {product.stock_quantity > 0 ? `남은 수량: ${product.stock_quantity} ${product.unit}` : "품절"}
                        </div>
                      </div>
                    </div>

                    {product.description && (
                      <p style={{ fontSize: "12px", color: "#64748b", backgroundColor: "#f8fafc", padding: "8px", borderRadius: "6px", marginTop: "8px" }}>
                        {product.description}
                      </p>
                    )}

                    {/* 발주 담기 버튼 (Phase 3 장바구니 연결 예정) */}
                    <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "flex-end" }}>
                      <button
                        disabled={product.stock_quantity <= 0}
                        onClick={() => alert(`'${product.name}' 장바구니 담기 기능은 Phase 3에서 활성화됩니다.`)}
                        style={{
                          backgroundColor: product.stock_quantity > 0 ? "#0f172a" : "#cbd5e1",
                          color: "#ffffff",
                          fontSize: "13px",
                          fontWeight: 600,
                          padding: "8px 16px",
                          borderRadius: "6px",
                          border: "none",
                          cursor: product.stock_quantity > 0 ? "pointer" : "not-allowed",
                        }}
                      >
                        {product.stock_quantity > 0 ? "+ 발주 담기" : "품절"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 푸터 법적 고지 (PRD Section 5 준수) */}
      <footer style={{ padding: "24px 16px", textAlign: "center", borderTop: "1px solid #e2e8f0", backgroundColor: "#ffffff", marginTop: "40px" }}>
        <p style={{ fontSize: "11px", color: "#94a3b8", lineHeight: "1.5" }}>
          본 상점은 <strong>{wholesaler.business_name}</strong>과 계약된 단골 식당을 위한 비공개 1:1 발주 공간입니다.
          <br />
          타 도매업자에게 정보가 일체 공유되지 않습니다.
        </p>
      </footer>
    </div>
  );
}
