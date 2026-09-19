"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { claimShopAccessAction } from "@/app/actions/buyer-auth";
import { useShopCart } from "@/lib/shop/cart-store";
import { cartTotals, quantityStepFor } from "@/lib/shop/order-policy";
import { toCartLines, type ShopCatalog, type ShopCatalogItem } from "@/lib/shop/catalog-types";
import { ShopFooter, ShopHeader, cardStyle, formatWon, shopPageStyle } from "./shop-chrome";
import { SampleBadge } from "@/components/sample-badge";

interface ShopViewProps {
  catalog: ShopCatalog;
  /** OAuth 콜백에서 전달된 인증 실패 안내 */
  authMessage?: string | null;
}

const CATEGORIES = ["전체", "소", "돼지", "닭/오리", "가공육/기타"] as const;
const MAIN_CATEGORIES = ["소", "돼지", "닭/오리"];

export function ShopView({ catalog, authMessage }: ShopViewProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"normal" | "secret">("normal");
  const [selectedCategory, setSelectedCategory] = useState<string>("전체");
  const [isPending, startTransition] = useTransition();
  const [sessionError, setSessionError] = useState<string | null>(authMessage ?? null);

  const { entries, isLoaded, quantityOf, stepQuantity } = useShopCart(catalog.shopToken);

  const totals = useMemo(
    () => cartTotals(toCartLines(catalog, entries)),
    [catalog, entries]
  );

  // 탭별 품목(기본 납품 품목 / 시크릿 딜)을 먼저 분리해 카운트와 목록에 함께 사용한다.
  const { normalItems, secretItems } = useMemo(() => {
    const normal: ShopCatalogItem[] = [];
    const secret: ShopCatalogItem[] = [];

    for (const item of catalog.items) {
      if (item.product.is_secret_deal) {
        secret.push(item);
      } else {
        normal.push(item);
      }
    }

    return { normalItems: normal, secretItems: secret };
  }, [catalog.items]);

  const tabItems = activeTab === "normal" ? normalItems : secretItems;

  const displayedItems = tabItems.filter((item) => {
    if (selectedCategory === "전체") {
      return true;
    }

    if (selectedCategory === "가공육/기타") {
      return !MAIN_CATEGORIES.includes(item.product.category);
    }

    return item.product.category === selectedCategory;
  });

  const availableCategories = useMemo(
    () =>
      CATEGORIES.filter((category) => {
        if (category === "전체") {
          return true;
        }

        if (category === "가공육/기타") {
          return tabItems.some((item) => !MAIN_CATEGORIES.includes(item.product.category));
        }

        return tabItems.some((item) => item.product.category === category);
      }),
    [tabItems]
  );

  // 탭 전환 시 카테고리 필터를 초기화한다.
  // (이전 탭에만 있던 카테고리가 남아 목록이 비어 보이는 문제 방지)
  const handleTabChange = (tab: "normal" | "secret") => {
    setActiveTab(tab);
    setSelectedCategory("전체");
  };

  /**
   * 단골 등록(초대 링크 클레임).
   *
   * 카카오 로그인 콜백에서 이미 자동 실행되지만, 다른 경로로 먼저 로그인한 계정이
   * 새 공급사의 알림톡 링크를 열었을 때 이 버튼으로 거래 관계를 맺는다.
   */
  const handleClaimAccess = () => {
    setSessionError(null);

    startTransition(async () => {
      const result = await claimShopAccessAction(catalog.shopToken);

      if (result.success) {
        router.refresh();
      } else {
        setSessionError(result.error ?? "단골 등록에 실패했습니다.");
      }
    });
  };

  return (
    <div style={{ ...shopPageStyle, paddingBottom: totals.itemCount > 0 ? "100px" : "20px" }}>
      <ShopHeader wholesaler={catalog.wholesaler} customer={catalog.customer}>
        {/* 일반 상품 / 시크릿 딜 탭 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "16px" }}>
          <button
            type="button"
            aria-pressed={activeTab === "normal"}
            onClick={() => handleTabChange("normal")}
            style={{
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              fontSize: "14px",
              fontWeight: 700,
              cursor: "pointer",
              backgroundColor: activeTab === "normal" ? "#0f172a" : "#f1f5f9",
              color: activeTab === "normal" ? "#ffffff" : "#334155",
            }}
          >
            기본 납품 품목 {normalItems.length}
          </button>
          <button
            type="button"
            aria-pressed={activeTab === "secret"}
            onClick={() => handleTabChange("secret")}
            style={{
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              fontSize: "14px",
              fontWeight: 700,
              cursor: "pointer",
              backgroundColor: activeTab === "secret" ? "#dc2626" : "#fee2e2",
              color: activeTab === "secret" ? "#ffffff" : "#b91c1c",
            }}
          >
            🔥 시크릿 특가 룸
          </button>
        </div>

        {/* 발주 내역 조회 / 주문 취소 요청 진입점 */}
        <Link
          href={`/shop/${catalog.shopToken}/orders`}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "8px",
            padding: "10px 12px",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            backgroundColor: "#f8fafc",
            fontSize: "13px",
            fontWeight: 600,
            color: "#334155",
            textDecoration: "none",
          }}
        >
          <span>📋 내 발주 내역 · 주문 취소 요청</span>
          <span style={{ color: "#475569" }}>→</span>
        </Link>
      </ShopHeader>

      <div style={{ padding: "16px" }}>
        {catalog.isDemo && (
          <div
            style={{
              backgroundColor: "#fffbeb",
              border: "1px solid #fde68a",
              color: "#92400e",
              fontSize: "13px",
              padding: "10px 12px",
              borderRadius: "8px",
              marginBottom: "12px",
            }}
          >
            시연(데모) 카탈로그입니다. 실제 공급사 데이터가 연결되면 등록된 상품과 계약 단가로 대체됩니다.
          </div>
        )}

        {catalog.customer.isLinked && (
          <div
            style={{
              backgroundColor: "#eff6ff",
              border: "1px solid #bfdbfe",
              color: "#1e40af",
              fontSize: "13px",
              padding: "10px 12px",
              borderRadius: "8px",
              marginBottom: "12px",
            }}
          >
            ✓ <strong>{catalog.customer.restaurantName}</strong> 전용 계약 단가가 적용된 가격입니다.
          </div>
        )}

        {activeTab === "secret" && !catalog.canViewSecretDeals ? (
          <div
            style={{
              ...cardStyle,
              borderColor: "#fecaca",
              padding: "36px 20px",
              textAlign: "center",
              marginTop: "20px",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>🔒</div>
            <h3 style={{ fontSize: "17px", fontWeight: 700, color: "#991b1b", marginBottom: "6px" }}>
              고객(소매) 전용 시크릿 딜 룸
            </h3>
            <p style={{ fontSize: "13px", color: "#475569", lineHeight: 1.6, marginBottom: "20px" }}>
              정규 시장 가격 붕괴를 방지하기 위해 <strong>인증된 단골 거래처</strong>에게만 한정 수량 당일 마감 특가가 공개됩니다.
            </p>

            {sessionError && (
              <p style={{ fontSize: "13px", color: "#dc2626", marginBottom: "12px" }}>{sessionError}</p>
            )}

            <button
              onClick={handleClaimAccess}
              disabled={isPending}
              style={{
                backgroundColor: "#fee500",
                color: "#181600",
                fontWeight: 700,
                fontSize: "14px",
                padding: "12px 24px",
                borderRadius: "8px",
                border: "none",
                cursor: isPending ? "not-allowed" : "pointer",
              }}
            >
              {isPending ? "단골 등록 확인 중..." : "이 공급사 단골로 등록하기"}
            </button>
          </div>
        ) : (
          <>
            {/* 카테고리 필터 — 현재 탭에 품목이 있는 카테고리만 노출한다. */}
            <div style={{ display: "flex", gap: "6px", overflowX: "auto", paddingBottom: "12px", marginBottom: "12px" }}>
              {availableCategories.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setSelectedCategory(category)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "20px",
                    border: "1px solid",
                    borderColor: selectedCategory === category ? "#0f172a" : "#e2e8f0",
                    backgroundColor: selectedCategory === category ? "#0f172a" : "#ffffff",
                    color: selectedCategory === category ? "#ffffff" : "#475569",
                    fontSize: "12px",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  {category}
                </button>
              ))}
            </div>

            {displayedItems.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "48px 16px",
                  background: "#ffffff",
                  borderRadius: "12px",
                  border: "1px dashed #cbd5e1",
                }}
              >
                <p style={{ color: "#334155", fontSize: "14px" }}>
                  {tabItems.length === 0
                    ? activeTab === "normal"
                      ? "공급사가 아직 기본 납품 품목을 등록하지 않았습니다."
                      : "현재 공개된 시크릿 특가 품목이 없습니다."
                    : `'${selectedCategory}' 카테고리에 해당하는 품목이 없습니다.`}
                </p>

                {tabItems.length > 0 && selectedCategory !== "전체" && (
                  <button
                    type="button"
                    onClick={() => setSelectedCategory("전체")}
                    style={{
                      marginTop: "12px",
                      backgroundColor: "#0f172a",
                      color: "#ffffff",
                      fontSize: "13px",
                      fontWeight: 600,
                      padding: "8px 16px",
                      borderRadius: "6px",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    전체 품목 보기
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: "grid", gap: "12px" }}>
                {displayedItems.map((item) => (
                  <ProductCard
                    key={item.product.id}
                    item={item}
                    quantity={isLoaded ? quantityOf(item.product.id) : 0}
                    onStep={(direction) =>
                      stepQuantity(
                        item.product.id,
                        direction,
                        item.product.unit,
                        Number(item.product.stock_quantity)
                      )
                    }
                    isDemo={catalog.isDemo}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 하단 플로팅 장바구니 바 */}
      {totals.itemCount > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: "16px",
            left: "50%",
            transform: "translateX(-50%)",
            width: "calc(100% - 32px)",
            maxWidth: "568px",
            backgroundColor: "#0f172a",
            color: "#ffffff",
            borderRadius: "16px",
            padding: "14px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            boxShadow: "0 10px 25px -5px rgba(0,0,0,0.3)",
            zIndex: 30,
          }}
        >
          <div>
            <span style={{ fontSize: "12px", color: "#cbd5e1" }}>담은 품목 {totals.itemCount}건</span>
            <div style={{ fontSize: "17px", fontWeight: 800 }}>{formatWon(totals.totalAmount)}</div>
          </div>

          <Link
            href={`/shop/${catalog.shopToken}/cart`}
            style={{
              backgroundColor: "#dc2626",
              color: "#ffffff",
              fontSize: "14px",
              fontWeight: 700,
              padding: "10px 20px",
              borderRadius: "10px",
              textDecoration: "none",
            }}
          >
            장바구니 확인 →
          </Link>
        </div>
      )}

      <ShopFooter businessName={catalog.wholesaler.business_name} />
    </div>
  );
}

interface ProductCardProps {
  item: ShopCatalogItem;
  quantity: number;
  onStep: (direction: 1 | -1) => void;
  isDemo?: boolean;
}

function ProductCard({ item, quantity, onStep, isDemo = false }: ProductCardProps) {
  const { product, effectivePrice, isCustomPrice } = item;
  const stock = Number(product.stock_quantity);
  const isSoldOut = stock <= 0;
  const step = quantityStepFor(product.unit);

  return (
    <div
      style={{
        ...cardStyle,
        padding: "16px",
        borderColor: quantity > 0 ? "#0f172a" : "#e2e8f0",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: "12px",
                fontWeight: 700,
                color: product.is_secret_deal ? "#b91c1c" : "#475569",
                backgroundColor: product.is_secret_deal ? "#fee2e2" : "#f1f5f9",
                padding: "2px 6px",
                borderRadius: "4px",
              }}
            >
              {product.category}
            </span>
            {product.subcategory && (
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "#475569",
                  backgroundColor: "#f1f5f9",
                  padding: "2px 6px",
                  borderRadius: "4px",
                }}
              >
                {product.subcategory}
              </span>
            )}
            <h3 style={{ fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>{product.name}</h3>
            {isDemo && <SampleBadge />}
          </div>
          <p style={{ fontSize: "12px", color: "#334155", marginTop: "4px" }}>
            원산지: {product.origin}
            {product.grade ? ` | 등급: ${product.grade}` : ""}
          </p>
        </div>

        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {isCustomPrice && (
            <div
              style={{
                fontSize: "12px",
                color: "#475569",
                textDecoration: "line-through",
              }}
            >
              {formatWon(Number(product.base_price))}
            </div>
          )}
          <div
            style={{
              fontSize: "17px",
              fontWeight: 800,
              color: product.is_secret_deal || isCustomPrice ? "#dc2626" : "#0f172a",
            }}
          >
            {formatWon(effectivePrice)}
            <span style={{ fontSize: "12px", fontWeight: 400, color: "#334155", marginLeft: "2px" }}>
              / {product.unit}
            </span>
          </div>
          <div
            style={{
              fontSize: "12px",
              color: isSoldOut ? "#dc2626" : "#166534",
              fontWeight: 600,
              marginTop: "2px",
            }}
          >
            {isSoldOut ? "품절" : `남은 수량: ${stock} ${product.unit}`}
          </div>
        </div>
      </div>

      {isCustomPrice && (
        <div
          style={{
            display: "inline-block",
            fontSize: "12px",
            fontWeight: 700,
            color: "#166534",
            backgroundColor: "#dcfce7",
            padding: "2px 6px",
            borderRadius: "4px",
            marginTop: "8px",
          }}
        >
          단골 맞춤 단가 적용
        </div>
      )}

      {product.description && (
        <p
          style={{
            fontSize: "13px",
            color: "#334155",
            backgroundColor: "#f8fafc",
            padding: "8px",
            borderRadius: "6px",
            marginTop: "8px",
          }}
        >
          {product.description}
        </p>
      )}

      <div
        style={{
          marginTop: "12px",
          paddingTop: "12px",
          borderTop: "1px solid #f1f5f9",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        {quantity > 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              backgroundColor: "#f1f5f9",
              padding: "4px 8px",
              borderRadius: "8px",
            }}
          >
            <StepButton label="-" onClick={() => onStep(-1)} />
            <span style={{ fontSize: "14px", fontWeight: 700, minWidth: "56px", textAlign: "center" }}>
              {quantity} {product.unit}
            </span>
            <StepButton label="+" onClick={() => onStep(1)} disabled={quantity >= stock} />
          </div>
        ) : (
          <button
            disabled={isSoldOut}
            onClick={() => onStep(1)}
            style={{
              backgroundColor: isSoldOut ? "#cbd5e1" : "#0f172a",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 600,
              padding: "8px 16px",
              borderRadius: "6px",
              border: "none",
              cursor: isSoldOut ? "not-allowed" : "pointer",
            }}
          >
            {isSoldOut ? "품절" : `+ ${step}${product.unit} 담기`}
          </button>
        )}
      </div>
    </div>
  );
}

function StepButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "28px",
        height: "28px",
        borderRadius: "6px",
        border: "1px solid #cbd5e1",
        backgroundColor: disabled ? "#f8fafc" : "#ffffff",
        color: disabled ? "#cbd5e1" : "#0f172a",
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: 800,
      }}
    >
      {label}
    </button>
  );
}
