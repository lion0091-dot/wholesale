"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { claimShopAccessAction } from "@/app/actions/buyer-auth";
import { useShopCart } from "@/lib/shop/cart-store";
import { cartTotals, quantityStepFor } from "@/lib/shop/order-policy";
import { toCartLines, type ShopCatalog, type ShopCatalogItem } from "@/lib/shop/catalog-types";
import { ShopFooter, ShopHeader, cardStyle, formatWon, shopPageStyle } from "./shop-chrome";

interface ShopViewProps {
  catalog: ShopCatalog;
  /** OAuth 콜백에서 전달된 인증 실패 안내 */
  authMessage?: string | null;
}

const CATEGORIES = ["전체", "소", "돼지", "닭/오리", "가공육/기타"] as const;
const MAIN_CATEGORIES = ["소", "돼지", "닭/오리"];
const PREVIEW_STATUS_LABELS: Record<string, string> = {
  pending: "승인 대기 중",
  suspended: "정지",
  rejected: "승인 거절",
  closed: "해지",
};

export function ShopView({ catalog, authMessage }: ShopViewProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"normal" | "hotdeal">("normal");
  const [selectedCategory, setSelectedCategory] = useState<string>("전체");
  const [isPending, startTransition] = useTransition();
  const [sessionError, setSessionError] = useState<string | null>(authMessage ?? null);

  const { entries, isLoaded, quantityOf, stepQuantity } = useShopCart(catalog.shopToken);
  const previewOnly = Boolean(catalog.previewStatus);

  const totals = useMemo(
    () => cartTotals(toCartLines(catalog, entries)),
    [catalog, entries]
  );

  // 탭별 품목(기본 납품 품목 / 핫딜)을 먼저 분리해 카운트와 목록에 함께 사용한다.
  // 핫딜은 상품 자체 속성(hot_deal_active)이라 비로그인 손님 포함 전체 공개다(2026-09-24 재설계).
  const { normalItems, hotDealItems } = useMemo(() => {
    const normal: ShopCatalogItem[] = [];
    const hotdeal: ShopCatalogItem[] = [];

    for (const item of catalog.items) {
      if (item.isHotDeal) {
        hotdeal.push(item);
      } else {
        normal.push(item);
      }
    }

    return { normalItems: normal, hotDealItems: hotdeal };
  }, [catalog.items]);

  // 핫딜 탭을 보던 중 마지막 핫딜 상품이 꺼지면(공급사가 오프) 빈 탭에 갇히지 않도록 되돌린다.
  useEffect(() => {
    if (activeTab === "hotdeal" && hotDealItems.length === 0) {
      setActiveTab("normal");
    }
  }, [activeTab, hotDealItems.length]);

  const tabItems = activeTab === "normal" ? normalItems : hotDealItems;

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
  const handleTabChange = (tab: "normal" | "hotdeal") => {
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
    <div style={{ ...shopPageStyle, paddingBottom: totals.itemCount > 0 && !previewOnly ? "100px" : "20px" }}>
      <ShopHeader wholesaler={catalog.wholesaler} customer={catalog.customer}>
        {/* 일반 상품 / 핫딜 탭 */}
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
            aria-pressed={activeTab === "hotdeal"}
            disabled={hotDealItems.length === 0}
            onClick={() => handleTabChange("hotdeal")}
            style={{
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              fontSize: "14px",
              fontWeight: 700,
              cursor: hotDealItems.length === 0 ? "not-allowed" : "pointer",
              backgroundColor:
                hotDealItems.length === 0 ? "#f1f5f9" : activeTab === "hotdeal" ? "#dc2626" : "#fee2e2",
              color: hotDealItems.length === 0 ? "#94a3b8" : activeTab === "hotdeal" ? "#ffffff" : "#b91c1c",
            }}
          >
            🔥 핫딜 {hotDealItems.length}
          </button>
        </div>

        {/* 발주 내역 조회 / 주문 취소 요청 진입점 */}
        {!previewOnly && (
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
          <span>📋 내 발주 내역 · 발주 취소 요청</span>
          <span style={{ color: "#475569" }}>→</span>
        </Link>
        )}
      </ShopHeader>

      <div style={{ padding: "16px" }}>

        {previewOnly ? (
          <div
            style={{
              backgroundColor: "#f5f3ff",
              border: "1px solid #c4b5fd",
              color: "#5b21b6",
              fontSize: "13px",
              lineHeight: 1.5,
              padding: "10px 12px",
              borderRadius: "8px",
              marginBottom: "12px",
            }}
          >
            {catalog.previewViewer === "supplier" ? (
              <>
                👁 <strong>내 미니샵 미리보기</strong> — {PREVIEW_STATUS_LABELS[catalog.previewStatus ?? ""] ?? "비활성"} 상태라
                고객에게는 아직 보이지 않습니다. 승인되면 이 화면이 고객에게 공개됩니다. 주문은 할 수 없습니다.
              </>
            ) : (
              <>
                👁 <strong>관리자 미리보기</strong> — {PREVIEW_STATUS_LABELS[catalog.previewStatus ?? ""] ?? "비활성"} 공급사라
                고객에게는 아직 보이지 않습니다. 승인 후 고객이 보게 될 화면이며, 주문은 할 수 없습니다.
              </>
            )}
          </div>
        ) : catalog.customer.isLinked ? (
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
        ) : (
          // 다른 공급사 경로로 먼저 로그인한 계정이 이 공급사 링크를 열었을 때를 위한
          // 수동 단골 등록 진입점(보통은 카카오 로그인 콜백에서 자동 처리됨). 등록 여부와
          // 무관하게 카탈로그(핫딜 포함)는 항상 보여야 하므로 화면을 막지 않는 배너로만 노출한다.
          <div
            style={{
              backgroundColor: "#fefce8",
              border: "1px solid #fde68a",
              color: "#854d0e",
              fontSize: "12px",
              padding: "8px 12px",
              borderRadius: "8px",
              marginBottom: "12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <span>단골로 등록하면 이 공급사의 계약 단가가 적용돼요.</span>
            <button
              type="button"
              onClick={handleClaimAccess}
              disabled={isPending}
              style={{
                backgroundColor: "#fee500",
                color: "#181600",
                fontWeight: 700,
                fontSize: "12px",
                padding: "6px 12px",
                borderRadius: "6px",
                border: "none",
                cursor: isPending ? "not-allowed" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {isPending ? "확인 중..." : "단골 등록하기"}
            </button>
          </div>
        )}

        {sessionError && (
          <p style={{ fontSize: "13px", color: "#dc2626", marginBottom: "12px" }}>{sessionError}</p>
        )}

        {activeTab === "hotdeal" && (
          <div
            style={{
              backgroundColor: "#fff1f2",
              border: "1px solid #fecdd3",
              color: "#9f1244",
              fontSize: "12px",
              lineHeight: 1.5,
              padding: "10px 12px",
              borderRadius: "8px",
              marginBottom: "12px",
            }}
          >
            🔥 핫딜 특가 상품도 일반 상품과 동일하게, 발주 취소는 공급사 승인이 있어야 처리됩니다.
          </div>
        )}

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
                      : "현재 지정된 핫딜 상품이 없습니다."
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
                    previewOnly={previewOnly}
                    quantity={isLoaded ? quantityOf(item.product.id) : 0}
                    onStep={(direction) =>
                      stepQuantity(item.product.id, direction, item.product.unit, item.orderableQuantity)
                    }
                  />
                ))}
              </div>
            )}
        </>
      </div>

      {/* 하단 플로팅 장바구니 바 */}
      {!previewOnly && totals.itemCount > 0 && (
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
  /** 관리자 미리보기 — 담기 컨트롤을 숨긴다 */
  previewOnly?: boolean;
}

function ProductCard({ item, quantity, onStep, previewOnly = false }: ProductCardProps) {
  const { product, effectivePrice, isCustomPrice, isHotDeal, orderableQuantity } = item;
  const stock = Number(product.stock_quantity);
  const isSoldOut = stock <= 0;
  // 발주정지는 재고와 별개로 걸릴 수 있다(핫딜 상품 수동 정지) — 재고가 남아있어도 주문은 막는다.
  const isOrderStopped = Boolean(product.order_stopped);
  const isUnavailable = isSoldOut || isOrderStopped;
  const unavailableLabel = isOrderStopped ? "일시 품절" : "품절";
  // 핫딜 한도가 재고보다 먼저 닿을 수 있다 — 그럴 땐 "남은 수량"도 한도 기준으로 보여줘서
  // 손님이 애초에 넘는 수량을 담지 못하게 한다(오버 주문은 화면에서부터 막는다).
  const hotDealCapped = isHotDeal && orderableQuantity < stock;
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
                color: isHotDeal ? "#b91c1c" : "#475569",
                backgroundColor: isHotDeal ? "#fee2e2" : "#f1f5f9",
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
          </div>
          <p style={{ fontSize: "12px", color: "#334155", marginTop: "4px" }}>
            원산지: {product.origin}
            {product.grade ? ` | 등급: ${product.grade}` : ""}
          </p>
        </div>

        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {(isCustomPrice || isHotDeal) && (
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
              color: isHotDeal || isCustomPrice ? "#dc2626" : "#0f172a",
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
              color: isUnavailable ? "#dc2626" : hotDealCapped ? "#c2410c" : "#166534",
              fontWeight: 600,
              marginTop: "2px",
            }}
          >
            {isUnavailable
              ? unavailableLabel
              : hotDealCapped
                ? `핫딜 남은 수량: ${orderableQuantity}${product.unit}`
                : `남은 수량: ${stock}${product.unit}`}
          </div>
        </div>
      </div>

      {isHotDeal ? (
        <div
          style={{
            display: "inline-block",
            fontSize: "12px",
            fontWeight: 700,
            color: "#b91c1c",
            backgroundColor: "#fee2e2",
            padding: "2px 6px",
            borderRadius: "4px",
            marginTop: "8px",
          }}
        >
          🔥 핫딜 특가 적용
        </div>
      ) : (
        isCustomPrice && (
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
        )
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
        {previewOnly ? (
          <span style={{ fontSize: "12px", color: "#6d28d9", fontWeight: 600 }}>미리보기 전용 · 주문 불가</span>
        ) : quantity > 0 ? (
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
            <StepButton
              label="+"
              onClick={() => onStep(1)}
              disabled={quantity >= orderableQuantity || isOrderStopped}
            />
          </div>
        ) : (
          <button
            disabled={isUnavailable}
            onClick={() => onStep(1)}
            style={{
              backgroundColor: isUnavailable ? "#cbd5e1" : "#0f172a",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 600,
              padding: "8px 16px",
              borderRadius: "6px",
              border: "none",
              cursor: isUnavailable ? "not-allowed" : "pointer",
            }}
          >
            {isUnavailable ? unavailableLabel : `+ ${step}${product.unit} 담기`}
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
